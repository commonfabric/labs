import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  appendSummary,
  cutToRoom,
  drawTables,
  fit,
  say,
  SUMMARY_LIMIT,
  writeWhole,
} from "./step-summary.ts";

const ENCODER = new TextEncoder();

/** How many bytes a piece of text takes in the summary file. */
function bytes(text: string): number {
  return ENCODER.encode(text).length;
}

/**
 * Runs `body` with the job summary pointed at a file of its own, and
 * returns what the file holds afterwards.
 */
async function withSummary(body: () => void): Promise<string> {
  const at = await Deno.makeTempFile({ prefix: "step-summary-" });
  const before = Deno.env.get("GITHUB_STEP_SUMMARY");
  Deno.env.set("GITHUB_STEP_SUMMARY", at);
  try {
    body();
    return await Deno.readTextFile(at);
  } finally {
    if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
    else Deno.env.set("GITHUB_STEP_SUMMARY", before);
    await Deno.remove(at);
  }
}

/** A text of `count` numbered lines, each `width` characters wide. */
function lines(count: number, width = 40): string {
  const rows: string[] = [];
  for (let at = 0; at < count; at++) {
    rows.push(`${at}`.padEnd(width, "-"));
  }
  return `${rows.join("\n")}\n`;
}

/** The pieces a writer took, back as the one text they came from. */
function concat(pieces: readonly Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(pieces.reduce((sum, at) => sum + at.length, 0));
  let at = 0;
  for (const piece of pieces) {
    whole.set(piece, at);
    at += piece.length;
  }
  return whole;
}

/** The line `fit` leaves in place of what it cut, as the module words it. */
const MARKER = `${fit(lines(1000), 500).split("\n").at(-2)}\n`;

describe("step-summary", () => {
  describe("fit()", () => {
    it("returns the text unchanged where it fits", () => {
      const text = lines(4);
      expect(fit(text, SUMMARY_LIMIT)).toBe(text);
    });

    it("returns the text unchanged where it is exactly the room given", () => {
      const text = lines(4);
      expect(fit(text, bytes(text))).toBe(text);
    });

    it("returns less than the whole text one byte short of room", () => {
      const text = lines(4);
      expect(fit(text, bytes(text) - 1)).not.toBe(text);
    });

    it("returns at most the room it was given", () => {
      const text = lines(1000);
      for (const room of [0, 1, 46, 200, 1000, bytes(text) - 1]) {
        expect(bytes(fit(text, room))).toBeLessThanOrEqual(room);
      }
    });

    it("returns whole lines, never half of one", () => {
      const text = lines(1000);
      const kept = fit(text, 500).split("\n").slice(0, -2);
      expect(kept.length).toBeGreaterThan(0);
      for (const line of kept) expect(text).toContain(`${line}\n`);
    });

    it("keeps a character whose bytes straddle the bound whole", () => {
      // Each line is one three-byte character, so a cut counted in bytes
      // rather than in lines would land inside one of them. The room is
      // the marker, ten of those lines, and two bytes over: enough that
      // a byte count would take part of an eleventh, and a line count
      // takes none of it.
      const text = `${Array(100).fill("☃").join("\n")}\n`;
      const kept = fit(text, bytes(MARKER) + 10 * 4 + 2);
      expect(kept).not.toContain("�");
      expect(kept.split("\n").filter((line) => line === "☃")).toHaveLength(10);
    });

    it("says that it cut, where it cut", () => {
      expect(fit(lines(1000), 500)).toContain("the rest of this is in");
    });

    it("says nothing about cutting where it did not cut", () => {
      expect(fit(lines(4), SUMMARY_LIMIT)).not.toContain("the rest of this");
    });

    it("returns nothing where not even the line saying so fits", () => {
      expect(fit(lines(1000), 5)).toBe("");
    });

    it("returns nothing where the room holds no whole line", () => {
      // What a summary already at the bound has room for. Saying it was
      // cut, over and over and with nothing between, says nothing.
      expect(fit(lines(1000), bytes(MARKER) + 10)).toBe("");
    });
  });

  describe("appendSummary()", () => {
    it("appends to the file the environment names", async () => {
      const held = await withSummary(() => {
        appendSummary("first\n");
        appendSummary("second\n");
      });
      expect(held).toBe("first\nsecond\n");
    });

    it("leaves the file inside the bound where the text is past it", async () => {
      const held = await withSummary(() => {
        appendSummary(lines(SUMMARY_LIMIT / 10));
      });
      expect(bytes(held)).toBeLessThanOrEqual(SUMMARY_LIMIT);
      expect(held).toContain("the rest of this is in");
    });

    it("counts what the file already holds, not one write alone", async () => {
      const half = lines(SUMMARY_LIMIT / 80);
      expect(bytes(half)).toBeLessThan(SUMMARY_LIMIT);
      const held = await withSummary(() => {
        for (let at = 0; at < 3; at++) appendSummary(half);
      });
      expect(bytes(held)).toBeLessThanOrEqual(SUMMARY_LIMIT);
    });

    it("creates the file where the write is what first makes it", async () => {
      const directory = await Deno.makeTempDir({ prefix: "step-summary-" });
      const at = `${directory}/summary.md`;
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      Deno.env.set("GITHUB_STEP_SUMMARY", at);
      try {
        appendSummary("first\n");
        expect(await Deno.readTextFile(at)).toBe("first\n");
      } finally {
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("throws where the path names something it cannot measure", async () => {
      // Anything but a file that is not there yet is a summary this
      // cannot keep inside the bound, and a job summary quietly not
      // written is what the bound exists to prevent.
      const file = await Deno.makeTempFile({ prefix: "step-summary-" });
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      Deno.env.set("GITHUB_STEP_SUMMARY", `${file}/below`);
      try {
        expect(() => appendSummary("nowhere\n")).toThrow();
      } finally {
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
        await Deno.remove(file);
      }
    });

    it("writes nothing where no summary file is named", async () => {
      // A run outside a GitHub job, which is every local run, and a
      // runner that named the variable and left it empty. The file the
      // variable named a moment ago stays as it was, so a writer that
      // held on to a path rather than reading the variable is caught.
      const at = await Deno.makeTempFile({ prefix: "step-summary-" });
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      try {
        Deno.env.set("GITHUB_STEP_SUMMARY", at);
        Deno.env.delete("GITHUB_STEP_SUMMARY");
        appendSummary("nowhere\n");
        Deno.env.set("GITHUB_STEP_SUMMARY", "");
        appendSummary("nowhere\n");
        expect(await Deno.readTextFile(at)).toBe("");
      } finally {
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
        await Deno.remove(at);
      }
    });
  });

  describe("drawTables()", () => {
    it("draws a table in box-drawing characters", () => {
      expect(drawTables(
        "| Suite | Units |\n| --- | --- |\n| repo-gates | 2 |\n| cli | 14 |",
      )).toBe(
        [
          "┌────────────┬───────┐",
          "│ Suite      │ Units │",
          "├────────────┼───────┤",
          "│ repo-gates │ 2     │",
          "│ cli        │ 14    │",
          "└────────────┴───────┘",
        ].join("\n"),
      );
    });

    it("returns the lines around a table as they were", () => {
      expect(
        drawTables("## Lane 1\n\n| a |\n| :-: |\n| b |\n\nafter\n"),
      ).toBe(
        "## Lane 1\n\n┌───┐\n│ a │\n├───┤\n│ b │\n└───┘\n\nafter\n",
      );
    });

    it("returns rows with no row of dashes under them as they were", () => {
      const text = "| not | a table |\n| still | not |\n";
      expect(drawTables(text)).toBe(text);
    });

    it("keeps an escaped pipe inside its cell", () => {
      expect(drawTables("| a \\| b |\n| --- |\n| c |")).toBe(
        "┌───────┐\n│ a | b │\n├───────┤\n│ c     │\n└───────┘",
      );
    });

    it("returns a table inside a code fence as it was", () => {
      const text = "```\n| a |\n| --- |\n| b |\n```\n| c |\n| --- |";
      expect(drawTables(text)).toBe(
        "```\n| a |\n| --- |\n| b |\n```\n┌───┐\n│ c │\n├───┤\n└───┘",
      );
    });

    it("pads a cell by the columns its characters take, not their count", () => {
      // A wide character takes two columns and a combining mark none.
      expect(drawTables("| 日本 |\n| --- |\n| e\u0301 |")).toBe(
        "┌──────┐\n│ 日本 │\n├──────┤\n│ e\u0301    │\n└──────┘",
      );
    });

    it("draws a row short of cells with the rest empty", () => {
      expect(drawTables("| a | b |\n| --- | --- |\n| c |")).toBe(
        "┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ c │   │\n└───┴───┘",
      );
    });
  });

  describe("cutToRoom()", () => {
    it("returns what fits, and a status of zero", () => {
      expect(cutToRoom(["--room", "500"], lines(1000))).toEqual({
        out: fit(lines(1000), 500),
        code: 0,
      });
    });

    it("returns the whole text where the room holds it", () => {
      const text = lines(4);
      expect(cutToRoom(["--room", "999999"], text).out).toBe(text);
    });

    it("returns a usage line and a status of two for bad arguments", () => {
      for (const args of [[], ["--room"], ["--room", "x"], ["--room", "-1"]]) {
        const { out, code } = cutToRoom(args, lines(4));
        expect(code).toBe(2);
        expect(out).toContain("usage: step-summary.ts");
      }
    });

    /** What the command line writes, run as the workflow step runs it. */
    async function cli(args: string[], text: string): Promise<string> {
      const command = new Deno.Command(Deno.execPath(), {
        args: ["run", "tasks/step-summary.ts", ...args],
        cwd: new URL("..", import.meta.url).pathname,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = command.stdin.getWriter();
      await writer.write(ENCODER.encode(text));
      await writer.close();
      const { code, stdout } = await command.output();
      expect(code).toBe(0);
      return new TextDecoder().decode(stdout);
    }

    it("writes a text of many thousands of lines whole", async () => {
      const room = 900_000;
      const out = await cli(["--room", `${room}`], lines(40_000));
      expect(bytes(out)).toBeGreaterThan(500_000);
      expect(out).toBe(fit(lines(40_000), room));
    });

    it("reads its text from standard input and writes what fits", async () => {
      const out = await cli(["--room", "200"], lines(1000));
      expect(out).toBe(fit(lines(1000), 200));
      expect(bytes(out)).toBeLessThanOrEqual(200);
    });
  });

  describe("writeWhole()", () => {
    /** A writer taking `each` bytes a call, as a pipe takes what it holds. */
    function taking(
      each: number,
    ): {
      written: Uint8Array[];
      write: (bytes: Uint8Array) => Promise<number>;
    } {
      const written: Uint8Array[] = [];
      return {
        written,
        write(bytes: Uint8Array) {
          const piece = bytes.subarray(0, each);
          written.push(piece.slice());
          return Promise.resolve(piece.length);
        },
      };
    }

    it("writes every byte, however little a write takes", async () => {
      // One write takes what the reader has room for and no more, so a
      // text past that size is delivered only if the writing goes on.
      const text = lines(50);
      const to = taking(7);
      await writeWhole(to, ENCODER.encode(text));
      expect(new TextDecoder().decode(concat(to.written))).toBe(text);
      expect(to.written.length).toBeGreaterThan(1);
    });

    it("writes a text one write already takes whole", async () => {
      const to = taking(1000);
      await writeWhole(to, ENCODER.encode(lines(4)));
      expect(to.written).toHaveLength(1);
    });

    it("throws where a write takes nothing, rather than never ending", async () => {
      await expect(writeWhole(taking(0), ENCODER.encode(lines(4))))
        .rejects.toThrow("wrote 0 of the");
    });
  });

  describe("say()", () => {
    it("draws its tables in the log and keeps them Markdown in the summary", async () => {
      const lines = ["| a |", "| --- |", "| b |"];
      const logged: string[] = [];
      const log = console.log;
      console.log = (line: string) => logged.push(line);
      let summary: string;
      try {
        summary = await withSummary(() => say(lines));
      } finally {
        console.log = log;
      }
      expect(summary).toBe("| a |\n| --- |\n| b |\n");
      expect(logged).toEqual(["┌───┐\n│ a │\n├───┤\n│ b │\n└───┘\n"]);
    });

    it("writes the lines to the summary as well as to the output", async () => {
      const said: string[] = [];
      const log = console.log;
      console.log = (...parts: unknown[]) => said.push(parts.join(" "));
      let held: string;
      try {
        held = await withSummary(() => say(["one", "two"]));
      } finally {
        console.log = log;
      }
      expect(held).toBe("one\ntwo\n");
      expect(said).toEqual(["one\ntwo\n"]);
    });
  });
});

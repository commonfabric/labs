import { assert, assertEquals } from "@std/assert";
import {
  cpLen,
  hex,
  paint,
  RESET,
  sgr,
  stripAnsi,
  visibleWidth,
} from "../lib/view/ansi.ts";

Deno.test("hex parses #rrggbb", () => {
  assertEquals(hex("#ff8800"), [255, 136, 0]);
  assertEquals(hex("000000"), [0, 0, 0]);
});

Deno.test("sgr builds truecolor codes and is empty for no-op", () => {
  assertEquals(sgr({}), "");
  assertEquals(sgr({ fg: [1, 2, 3] }), "\x1b[38;2;1;2;3m");
  assertEquals(sgr({ bold: true, fg: [1, 2, 3] }), "\x1b[1;38;2;1;2;3m");
  assertEquals(sgr({ bg: [4, 5, 6] }), "\x1b[48;2;4;5;6m");
});

Deno.test("paint wraps and resets; no-op style leaves text untouched", () => {
  assertEquals(paint("x", {}), "x");
  assertEquals(paint("x", { fg: [1, 2, 3] }), `\x1b[38;2;1;2;3mx${RESET}`);
});

Deno.test("stripAnsi / visibleWidth ignore escapes", () => {
  const colored = paint("hello", { fg: [10, 20, 30], bold: true });
  assertEquals(stripAnsi(colored), "hello");
  assertEquals(visibleWidth(colored), 5);
  assert(colored.length > 5, "the colored form has escapes");
});

Deno.test("cpLen counts a non-BMP glyph as one display column", () => {
  // `𝑻` (U+1D47B) is a surrogate pair: two UTF-16 units, one column.
  assertEquals("𝑻".length, 2, "two UTF-16 code units");
  assertEquals(cpLen("𝑻"), 1, "one display column");
  assertEquals(cpLen("a𝑻b"), 3);
  assertEquals(cpLen(""), 0);
  // visibleWidth (cpLen after stripping escapes) agrees
  assertEquals(visibleWidth(paint("𝑻 lift", { bold: true })), 6);
});

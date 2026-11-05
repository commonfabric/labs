import { assert, assertEquals } from "@std/assert";
import {
  cpLen,
  hex,
  paint,
  RESET,
  sgr,
  stripAnsi,
  term,
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

Deno.test("cpLen counts a lone surrogate as one column, as for...of does", () => {
  for (
    const text of [
      "\udc7b",
      "\udc7baB",
      "a\ud835",
      "\ud835\ud835\udc7b",
      "\udc7b\ud835",
    ]
  ) {
    assertEquals(cpLen(text), [...text].length, JSON.stringify(text));
  }
  assertEquals(cpLen("\udc7baB"), 3);
  assertEquals(cpLen("\ud835\udc7b"), 1, "a pair is still one column");
});

Deno.test("hyperlink percent-encodes what in its address could drive the terminal, as UTF-8", () => {
  const link = term.hyperlink("https://x/a b\x07\x1b]0;é\x9c", "go");

  assertEquals(
    link,
    "\x1b]8;;https://x/a%20b%07%1B]0;%C3%A9%C2%9C\x07go\x1b]8;;\x07",
  );
  assertEquals(
    term.hyperlink("https://example.com/p?q=1#f", "x"),
    "\x1b]8;;https://example.com/p?q=1#f\x07x\x1b]8;;\x07",
  );
});

import { assertEquals } from "@std/assert";
import {
  resetRetiredElementWarnings,
  warnRetiredElementUsed,
} from "../src/v2/core/retired-element.ts";

// The warning has to be loud enough to find and quiet enough to leave on. A
// retired element sits inside a `.map(...)` over durable data, so warning per
// USE means one line per row per render — a wall that gets muted, which is the
// same as no warning. Once per element per session is the contract.

function captureWarnings(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    run();
  } finally {
    console.warn = original;
  }
  return lines;
}

Deno.test("a retired element warns once per session, not once per use", () => {
  resetRetiredElementWarnings();
  const lines = captureWarnings(() => {
    warnRetiredElementUsed("cf-cell-context", "cf-piece-menu");
    warnRetiredElementUsed("cf-cell-context", "cf-piece-menu");
    warnRetiredElementUsed("cf-cell-context", "cf-piece-menu");
  });
  assertEquals(lines.length, 1);
});

Deno.test("each retired element gets its own warning", () => {
  resetRetiredElementWarnings();
  const lines = captureWarnings(() => {
    warnRetiredElementUsed("cf-cell-context", "cf-piece-menu");
    warnRetiredElementUsed("cf-some-other-retired-thing");
  });
  assertEquals(lines.length, 2);
});

Deno.test("the warning names the element and its replacement", () => {
  resetRetiredElementWarnings();
  const [line] = captureWarnings(() => {
    warnRetiredElementUsed("cf-cell-context", "cf-piece-menu");
  });
  // The point of the line is telling an author what to change and to what, so
  // both names are part of the contract rather than incidental phrasing.
  assertEquals(line.includes("cf-cell-context"), true);
  assertEquals(line.includes("cf-piece-menu"), true);
});

Deno.test("a retired element with no successor still warns", () => {
  resetRetiredElementWarnings();
  const [line] = captureWarnings(() => {
    warnRetiredElementUsed("cf-no-successor");
  });
  assertEquals(line.includes("cf-no-successor"), true);
});

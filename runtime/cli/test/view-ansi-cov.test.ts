import { assert, assertEquals } from "@std/assert";
import { CSI, paint, RESET, sgr, stripAnsi, term } from "../lib/view/ansi.ts";

Deno.test("sgr emits the italic code (3)", () => {
  assertEquals(sgr({ italic: true }), `${CSI}3m`);
});

Deno.test("sgr emits the underline code (4)", () => {
  assertEquals(sgr({ underline: true }), `${CSI}4m`);
});

Deno.test("sgr combines bold/dim/italic/underline in order", () => {
  // Codes are pushed in declaration order: bold(1), dim(2), italic(3),
  // underline(4), then any fg/bg.
  assertEquals(
    sgr({ bold: true, dim: true, italic: true, underline: true }),
    `${CSI}1;2;3;4m`,
  );
  assertEquals(
    sgr({ italic: true, underline: true, fg: [7, 8, 9] }),
    `${CSI}3;4;38;2;7;8;9m`,
  );
});

Deno.test("paint round-trips through italic/underline styling", () => {
  const out = paint("hi", { italic: true, underline: true });
  assertEquals(out, `${CSI}3;4mhi${RESET}`);
  // The visible text survives stripping the escapes.
  assertEquals(stripAnsi(out), "hi");
});

Deno.test("term.moveTo builds a 1-based cursor-position escape", () => {
  assertEquals(term.moveTo(1, 1), `${CSI}1;1H`);
  assertEquals(term.moveTo(12, 40), `${CSI}12;40H`);
  // Row precedes column in the CSI ... H sequence.
  assertEquals(term.moveTo(3, 7), `${CSI}3;7H`);
  assert(term.moveTo(5, 9).endsWith("H"), "ends with the cursor-position verb");
});

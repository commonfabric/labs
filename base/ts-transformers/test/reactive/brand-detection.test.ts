import { assert, assertEquals } from "@std/assert";
import {
  getCellKind,
  isBrandedCellType,
} from "../../src/transformers/cell-type.ts";
import { analyzeExpression, CELL_VARIANTS_PRELUDE } from "./harness.ts";

Deno.test("detects opaque brand", () => {
  const { checker, expression } = analyzeExpression("state.count");
  const type = checker.getTypeAtLocation(expression);
  assert(isBrandedCellType(type, checker));
  assertEquals(getCellKind(type, checker), "opaque");
});

Deno.test("detects cell brand variants", () => {
  const variants: Array<
    [
      string,
      "cell" | "stream" | "opaque" | "comparable" | "readonly" | "writeonly",
    ]
  > = [
    ["cells.cell", "cell"],
    ["cells.comparable", "comparable"],
    ["cells.readonly", "readonly"],
    ["cells.writeonly", "writeonly"],
    ["cells.stream", "stream"],
  ];

  for (const [expr, expectedKind] of variants) {
    const { checker, expression } = analyzeExpression(expr, {
      prelude: CELL_VARIANTS_PRELUDE,
    });
    const type = checker.getTypeAtLocation(expression);
    assert(
      isBrandedCellType(type, checker),
      `${expr} should be treated as cell`,
    );
    assertEquals(
      getCellKind(type, checker),
      expectedKind,
      `unexpected cell kind for ${expr}`,
    );
  }
});

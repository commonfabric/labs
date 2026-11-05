import { assert, assertEquals } from "@std/assert";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { validateFiles } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

/**
 * These cases exercise the angle-bracket type-assertion (`<X>expr`) branches of
 * the cast validator, plus the double-cast detection paths for mixed and
 * parenthesized cast syntax. Angle-bracket assertions are only parseable in
 * plain `.ts` sources (they collide with JSX in `.tsx`), so every case drives a
 * `.ts` file through `validateFiles` rather than the default `.tsx` harness.
 */

async function diagnose(
  source: string,
): Promise<readonly TransformationDiagnostic[]> {
  const { diagnostics } = await validateFiles({ "/cast.ts": source }, {
    types: COMMONFABRIC_TYPES,
  });
  return diagnostics;
}

function types(diagnostics: readonly TransformationDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.type);
}

Deno.test(
  "angle-bracket cast to a cell-like type reports a cell-cast error",
  async () => {
    const source = `
      import { Cell } from "commonfabric";
      const data: any = { value: 42 };
      const cell = <Cell<number>>data;
    `;
    const diagnostics = await diagnose(source);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0]!.type, "cast-validation:cell-cast");
    assert(diagnostics[0]!.message.includes("Cell<>"));
  },
);

Deno.test(
  "angle-bracket cast to Reactive reports a forbidden-cast error",
  async () => {
    const source = `
      import { Reactive } from "commonfabric";
      const data: any = { value: 42 };
      const ref = <Reactive<number>>data;
    `;
    const diagnostics = await diagnose(source);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0]!.type, "cast-validation:forbidden-cast");
  },
);

Deno.test(
  "double angle-bracket cast '<X><unknown>expr' reports double-unknown",
  async () => {
    const source = `
      import { Cell } from "commonfabric";
      const data: any = { value: 42 };
      const cell = <Cell<number>><unknown>data;
    `;
    const diagnostics = await diagnose(source);
    assertEquals(types(diagnostics), ["cast-validation:double-unknown"]);
    assert(diagnostics[0]!.message.includes("<unknown>"));
  },
);

Deno.test(
  "mixed cast '<X>(expr as unknown)' reports double-unknown",
  async () => {
    const source = `
      import { Cell } from "commonfabric";
      const data: any = { value: 42 };
      const cell = <Cell<number>>(data as unknown);
    `;
    const diagnostics = await diagnose(source);
    assertEquals(types(diagnostics), ["cast-validation:double-unknown"]);
  },
);

Deno.test(
  "mixed cast '<X>(<unknown>expr)' with parentheses reports double-unknown",
  async () => {
    const source = `
      import { Cell } from "commonfabric";
      const data: any = { value: 42 };
      const cell = <Cell<number>>(<unknown>data);
    `;
    const diagnostics = await diagnose(source);
    assertEquals(types(diagnostics), ["cast-validation:double-unknown"]);
  },
);

Deno.test(
  "angle-bracket cast wrapping 'expr as unknown' reports double-unknown",
  async () => {
    const source = `
      import { Cell } from "commonfabric";
      const data: any = { value: 42 };
      const cell = <Cell<number>>data as unknown as Cell<number>;
    `;
    // The outer node here is an `as` expression whose inner is `<Cell>data as
    // unknown`; the `as unknown as Cell<number>` shape drives the AsExpression
    // double-unknown detection alongside the angle-bracket inner.
    const diagnostics = await diagnose(source);
    assert(
      diagnostics.some((d) => d.type === "cast-validation:double-unknown"),
    );
  },
);

Deno.test(
  "mixed cast '(<unknown>expr) as X' reports double-unknown",
  async () => {
    const source = `
      import { Cell } from "commonfabric";
      const data: any = { value: 42 };
      const cell = (<unknown>data) as Cell<number>;
    `;
    const diagnostics = await diagnose(source);
    assert(
      diagnostics.some((d) => d.type === "cast-validation:double-unknown"),
    );
  },
);

Deno.test(
  "parenthesized cast '(expr as unknown) as X' reports double-unknown",
  async () => {
    const source = `
      import { Cell } from "commonfabric";
      const data: any = { value: 42 };
      const cell = (data as unknown) as Cell<number>;
    `;
    const diagnostics = await diagnose(source);
    assert(
      diagnostics.some((d) => d.type === "cast-validation:double-unknown"),
    );
  },
);

Deno.test(
  "angle-bracket cast to a benign type produces no diagnostic",
  async () => {
    const source = `
      const data: any = { value: 42 };
      const value = <number>data;
    `;
    const diagnostics = await diagnose(source);
    assertEquals(diagnostics.length, 0);
  },
);

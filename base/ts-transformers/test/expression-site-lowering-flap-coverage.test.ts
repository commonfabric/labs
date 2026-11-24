import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsMatching, callsNamed, parseModule } from "./transformed-ast.ts";

// A few branches in expression-site-lowering.ts run only while a pattern
// compiles through the transformer from cold. When CI's compile cache is warm
// the compilation is skipped, so the same code alternates between covered and
// uncovered across runs of identical source. These unit tests drive each branch
// directly from small pattern sources and assert on the real transformed
// output, so the branches stay covered regardless of cache state.
//
// The assertions parse the printed output back into an AST and inspect real
// nodes (a lowered `mapWithPattern` call, a preserved arithmetic binary
// expression, a helper call's argument list) rather than matching printed text,
// so a preserved comment or an input substring cannot satisfy them.

function t(source: string): Promise<string> {
  return transformSource(source, { types: COMMONFABRIC_TYPES });
}

const HEAD = `/// <cts-enable />
import { Cell, pattern, ifElse, UI, VNode } from "commonfabric";
`;

Deno.test(
  "helper-owned pass leaves a pure-arithmetic ifElse argument unlowered",
  async () => {
    // The `1 + 2` and `3 + 4` branch values are arguments of `ifElse`, so the
    // helper-owned expression-site pass classifies them as owned by the helper.
    // Neither reads a reactive value, so the pass finds nothing to lift and
    // returns each argument unchanged (the not-lowerable guard). The arithmetic
    // survives verbatim as a binary expression inside the emitted `ifElse` call,
    // and no reactive `__cfLift*` wrapper is introduced for them.
    const source = `${HEAD}
interface Input { flag: Cell<boolean>; }
interface Output { [UI]: VNode; }
export default pattern<Input, Output>(({ flag }) => ({
  [UI]: <div>{ifElse(flag, 1 + 2, 3 + 4)}</div>,
}));`;
    const output = parseModule(await t(source));

    // The `ifElse` call survives (schemas are injected ahead of the runtime
    // arguments), and its two branch values are still `+` binary expressions.
    const ifElseCalls = callsNamed(output, "ifElse");
    assertEquals(ifElseCalls.length, 1);
    const call = ifElseCalls[0]!;
    const additions = call.arguments.filter(
      (arg): arg is ts.BinaryExpression =>
        ts.isBinaryExpression(arg) &&
        arg.operatorToken.kind === ts.SyntaxKind.PlusToken,
    );
    assertEquals(additions.length, 2);

    // No lift wrapper was produced anywhere: the arithmetic was not lowered.
    assertEquals(callsMatching(output, /^__cfLift/).length, 0);
  },
);

Deno.test(
  "helper-owned pass lowers a provenance-reactive map nested in a reactive map callback",
  async () => {
    // `nums` is the result of a plain function whose argument is a reactive read,
    // so the type checker sees a plain `number[]` while the value is reactive at
    // runtime. The outer `items.map(...)` is lowered by the earlier pattern-owned
    // pass, which does not recurse into its expression-bodied callback. That
    // leaves the inner `nums.map(...)` un-lowered until the helper-owned pass,
    // where the late array-method rewrite recognizes its shared reactive
    // collection provenance and lowers it to `mapWithPattern`.
    const source = `${HEAD}
function toNums(s: string): number[] { return [s.length]; }
interface Row { x: Cell<number>; }
interface Input { items: Cell<Row[]>; layout: Cell<string>; }
interface Output { [UI]: VNode; }
export default pattern<Input, Output>(({ items, layout }) => {
  const eff = layout.get();
  const nums = toNums(eff);
  return {
    [UI]: (
      <div>{items.map((row) => <span>{nums.map((n) => n + row.x.get())}</span>)}</div>
    ),
  };
});`;
    const output = parseModule(await t(source));

    // Both the outer (pattern-owned) and inner (helper-owned) array methods were
    // lowered to their reactive `mapWithPattern` variants.
    const mapWithPattern = callsNamed(output, "mapWithPattern");
    assertEquals(mapWithPattern.length, 2);

    // The inner lowered call operates on the provenance-reactive `nums` receiver.
    const innerReceivers = mapWithPattern
      .map((call) => call.expression)
      .filter(ts.isPropertyAccessExpression)
      .map((access) => access.expression)
      .filter(ts.isIdentifier)
      .map((id) => id.text);
    assert(
      innerReceivers.includes("nums"),
      "expected the inner map over `nums` to lower to mapWithPattern",
    );

    // No plain `.map(` call survives: every reactive array method was lowered.
    assertEquals(callsNamed(output, "map").length, 0);
  },
);

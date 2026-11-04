import { assert } from "@std/assert";
import ts from "typescript";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, parseModule } from "./transformed-ast.ts";

// The default export is `__cfHelpers.__cf_data(helper)`: one call to the member
// `__cf_data` whose sole argument is the identifier `helper`.
function wrapsHelper(out: string): boolean {
  const calls = callsNamed(parseModule(out), "__cf_data");
  return calls.some((call) => {
    const arg = call.arguments[0];
    return call.arguments.length === 1 && arg !== undefined &&
      ts.isIdentifier(arg) && arg.text === "helper";
  });
}

// The module-scope cf-data transformer wraps a default-exported callable with
// `__cfHelpers.__cf_data` when that callable's body may return a call applied to
// another call result (the `factory()()` shape). These tests drive the decision
// logic that classifies a callable as such.

const PRELUDE = [
  'import { pattern } from "commonfabric";',
  "declare function factory(): () => number;",
].join("\n");

async function transform(lines: string[]): Promise<string> {
  return await transformSource([PRELUDE, ...lines].join("\n"), {
    types: COMMONFABRIC_TYPES,
  });
}

Deno.test("module-scope cf-data wraps an arrow callable returning a call-on-call result", async () => {
  const out = await transform([
    "const helper = () => factory()();",
    "export default helper;",
  ]);
  assert(wrapsHelper(out));
});

Deno.test("module-scope cf-data wraps a block-body callable whose return is a call-on-call result", async () => {
  const out = await transform([
    "const helper = () => {",
    "  const seed = 1;",
    "  const next = seed + 1;",
    "  return factory()();",
    "};",
    "export default helper;",
  ]);
  assert(wrapsHelper(out));
});

Deno.test("module-scope cf-data wraps when the call-on-call result is nested in the returned expression", async () => {
  const out = await transform([
    "const helper = () => ({ value: factory()() });",
    "export default helper;",
  ]);
  assert(wrapsHelper(out));
});

Deno.test("module-scope cf-data ignores a call-on-call result inside a nested function boundary", async () => {
  const out = await transform([
    "const helper = () => {",
    "  const inner = () => factory()();",
    "  return inner;",
    "};",
    "export default helper;",
  ]);
  // The call-on-call result lives inside the inner arrow, which is a traversal
  // boundary, so the outer callable is not treated as returning a call result.
  assert(!wrapsHelper(out), "expected helper to be left unwrapped");
});

Deno.test("module-scope cf-data ignores a callable whose body expression is itself a function", async () => {
  const out = await transform([
    "const helper = () => () => factory()();",
    "export default helper;",
  ]);
  // The arrow body is a function expression — a traversal boundary — so the
  // nested call-on-call result is not attributed to `helper`.
  assert(!wrapsHelper(out), "expected helper to be left unwrapped");
});

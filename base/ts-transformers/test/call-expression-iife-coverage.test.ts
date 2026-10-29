import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  calleeName,
  callsMatching,
  extractedCallbackBody,
  hasKeyPathRead,
  iifeCalls,
  parseModule,
} from "./transformed-ast.ts";

// `emitCallExpression` has a dedicated branch for an authored zero-argument
// inline IIFE — `(() => ...)()` — that reads a cell from a reactive position.
// Outside these tests the branch is reached only as a side effect of patterns
// compiling through the transformer in CI's pattern-integration jobs, so its
// coverage flaps in the coverage-debt gate whenever those jobs' compile cache is
// warm. These tests reach it deterministically from two reactive positions and
// assert on how it treats the IIFE. Which sub-path runs depends on whether the
// reactive-wrapper builder can bind the IIFE's receiver: an element cell from a
// `.map()`/`.filter()` callback lets it succeed and rewrite the read in place,
// while a top-level cell inside an `ifElse` conditional makes it decline and
// fall through to the `createLiftAppliedCall` path.
//
// The assertions parse the transformer output back into an AST and inspect real
// nodes (a `__cfLift*` wrapper call, an immediately-invoked function, a
// `<receiver>.key("segment")` reactive path read) rather than matching printed
// text, so they cannot be satisfied by a preserved comment or by a substring
// that already appears in the input source.

const HEAD = `/// <cts-enable />
import { Cell, pattern, UI, VNode } from "commonfabric";
interface Row { x: Cell<number>; label: Cell<string>; }
interface Input { items: Cell<Row[]>; base: Cell<number>; }
interface Output { [UI]: VNode; }
`;

async function transformRender(body: string): Promise<ts.SourceFile> {
  const source = `${HEAD}
export default pattern<Input, Output>(({ items, base }) => ({
  [UI]: <div>{${body}}</div>,
}));`;
  return parseModule(
    await transformSource(source, { types: COMMONFABRIC_TYPES }),
  );
}

/** The lowered `mapWithPattern` callback body, isolated for assertions. */
function mapCallbackBody(output: ts.SourceFile): ts.Node {
  return extractedCallbackBody(output, "__cfPattern_1");
}

Deno.test(
  "zero-arg IIFE reading an element cell inside a map callback wraps the read into a reactive lift",
  async () => {
    const output = await transformRender(
      `items.map((item) => (() => item.x.get())() + 1)`,
    );
    // The map lowered to a `mapWithPattern` pattern callback.
    assert(callsMatching(output, /^mapWithPattern$/).length === 1);

    const body = mapCallbackBody(output);
    // The IIFE was replaced by a `__cfLift*` wrapper call — the authored
    // immediately-invoked function no longer appears in the lowered body.
    assertEquals(callsMatching(body, /^__cfLift/).length, 1);
    assertEquals(iifeCalls(body).length, 0);
    // The element cell read survived as a `item.key("x")` reactive dependency.
    assert(hasKeyPathRead(body, "x", "item"));
  },
);

Deno.test(
  "zero-arg IIFE mixing an outer cell and an element cell tracks both dependencies",
  async () => {
    const output = await transformRender(
      `items.map((item) => (() => base.get() || 0)() + item.x.get())`,
    );
    const body = mapCallbackBody(output);
    // Both dependencies reach the lift input, so neither is lost across the IIFE
    // boundary: the outer `base` cell (passed by identifier) and the element's
    // `item.key("x")` reactive path read.
    const lift = callsMatching(body, /^__cfLift/);
    assertEquals(lift.length, 1);
    const inputArg = lift[0]!.arguments[0];
    assert(inputArg && ts.isObjectLiteralExpression(inputArg));
    const propNames = inputArg.properties.map((p) =>
      p.name && ts.isIdentifier(p.name) ? p.name.text : undefined
    );
    assert(
      propNames.includes("base"),
      "expected the outer base cell as a lift input",
    );
    assert(hasKeyPathRead(body, "x", "item"));
  },
);

Deno.test(
  "zero-arg IIFE read inside a filter predicate is wrapped while the chain lowers",
  async () => {
    const output = await transformRender(
      `items.filter((item) => (() => item.x.get() > 0)()).map((item) => item.label)`,
    );
    // The filter+map chain lowers to filterWithPattern/mapWithPattern.
    assertEquals(callsMatching(output, /^filterWithPattern$/).length, 1);
    assertEquals(callsMatching(output, /^mapWithPattern$/).length, 1);
    // The predicate IIFE's cell read is wrapped into a lift over `item.key("x")`.
    assert(callsMatching(output, /^__cfLift/).length >= 1);
    assert(hasKeyPathRead(output, "x", "item"));
  },
);

Deno.test(
  "zero-arg IIFE decomposing through a local alias is preserved verbatim",
  async () => {
    const output = await transformRender(
      `items.map((item) => (() => { const p = item.x.get() || 0; return p; })() + 1)`,
    );
    const body = mapCallbackBody(output);
    // The IIFE holds a local alias (`const p = item.x.get() || 0`), so the branch
    // leaves the authored IIFE in place — it is still an immediately-invoked
    // function and was not replaced by a lift wrapper — for the inner machinery
    // to decompose.
    assertEquals(iifeCalls(body).length, 1);
    assertEquals(callsMatching(body, /^__cfLift/).length, 0);
  },
);

Deno.test(
  "zero-arg IIFE projecting an object-literal property is preserved verbatim",
  async () => {
    const output = await transformRender(
      `items.map((item) => (() => ({ v: item.x.get() }))().v)`,
    );
    const body = mapCallbackBody(output);
    // The IIFE returns an object literal that is immediately projected (`.v`);
    // no direct external cell read survives the child rewrite, so the IIFE is
    // returned unchanged and not wrapped in a lift.
    assertEquals(iifeCalls(body).length, 1);
    assertEquals(callsMatching(body, /^__cfLift/).length, 0);
  },
);

Deno.test(
  "zero-arg IIFE reading a top-level cell inside an ifElse branch wraps the whole IIFE in a lift applied to that cell",
  async () => {
    // This test covers the `createLiftAppliedCall` sub-path directly: a
    // zero-arg IIFE reading a top-level pattern cell inside an `ifElse` branch,
    // which the array-method tests above never reach.

    const output = parseModule(
      await transformSource(
        `/// <cts-enable />
import { Cell, ifElse, pattern, UI, VNode } from "commonfabric";
interface Input { enabled: Cell<boolean>; show: Cell<boolean>; }
interface Output { [UI]: VNode; }
export default pattern<Input, Output>(({ enabled, show }) => ({
  [UI]: (
    <div>
      {ifElse(
        show,
        <div>
          {(() => {
            const rawEnabled = enabled.get();
            return typeof rawEnabled === "boolean" ? rawEnabled : true;
          })()}
        </div>,
        null,
      )}
    </div>
  ),
}));`,
        { types: COMMONFABRIC_TYPES },
      ),
    );

    // The authored IIFE was lowered to a `__cfLift*` wrapper applied with the
    // top-level `enabled` cell hoisted as its input (passed by identifier, not
    // as an element `.key(...)` path read as the array-method path produces).
    const appliedWithEnabled = callsMatching(output, /^__cfLift/).filter(
      (call) => {
        const arg = call.arguments[0];
        return !!arg && ts.isObjectLiteralExpression(arg) &&
          arg.properties.some((p) =>
            !!p.name && ts.isIdentifier(p.name) && p.name.text === "enabled"
          );
      },
    );
    assertEquals(appliedWithEnabled.length, 1);
    const appliedCall = appliedWithEnabled[0]!;

    // That applied lift sits inside a reactive `ifElse` conditional — the
    // position that makes the wrapper builder decline (no element receiver to
    // bind) and fall through to `createLiftAppliedCall`.
    let ancestor: ts.Node | undefined = appliedCall.parent;
    let insideIfElse = false;
    while (ancestor) {
      if (ts.isCallExpression(ancestor) && calleeName(ancestor) === "ifElse") {
        insideIfElse = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    assert(
      insideIfElse,
      "expected the lift application inside an ifElse branch",
    );

    // The matching lift definition preserves the whole authored IIFE: its
    // factory body is still an immediately-invoked function. This is the
    // `createLiftAppliedCall` fallback wrapping the IIFE wholesale, in contrast
    // to the array-method path above, which decomposes the IIFE away.
    const liftName = calleeName(appliedCall);
    assert(liftName, "expected a named lift wrapper");
    const liftBody = extractedCallbackBody(output, liftName);
    assertEquals(iifeCalls(liftBody).length, 1);
  },
);

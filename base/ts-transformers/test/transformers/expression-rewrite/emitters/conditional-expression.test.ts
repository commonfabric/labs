/**
 * Compiles a bound handler whose binding argument holds a reactive
 * computation, once as a ternary's branch and once bare, to show where the
 * compute-wrap guard draws its line: a computation inline in a builder's
 * arguments is refused with an author-facing diagnostic, but one a ternary
 * holds as a branch is the ternary's to lower.
 */
import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../../../commonfabric-test-types.ts";
import {
  calleeName,
  callsMatching,
  callsNamed,
  parseModule,
} from "../../../transformed-ast.ts";
import { validateSource } from "../../../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A pattern binding `join`'s `isFirst` to `isFirst`, written inline. */
async function compileBinding(isFirst: string) {
  const { diagnostics, output } = await validateSource(
    `import { Default, handler, pattern } from "commonfabric";

const join = handler<{ name: string }, { isFirst: boolean }>(() => {});

interface State {
  flag: boolean;
  users: Default<string[], []>;
}

export default pattern<State>(({ flag, users }) => {
  const boundJoin = join({ isFirst: ${isFirst} });
  return { boundJoin };
});
`,
    { types: COMMONFABRIC_TYPES },
  );
  return { diagnostics, root: parseModule(output) };
}

describe("emitConditionalExpression()", () => {
  it("lifts a ternary branch written inline in a builder's arguments and reports nothing", async () => {
    const { diagnostics, root } = await compileBinding(
      "flag ? users.length === 0 : false",
    );

    // `ifElse` takes four schemas, then the predicate and the two branches.
    const [ifElse] = callsNamed(root, "ifElse");
    const printer = ts.createPrinter();
    expect(
      ifElse?.arguments.slice(4).map((argument) =>
        ts.isCallExpression(argument)
          ? `${calleeName(argument)}(...)`
          : printer.printNode(ts.EmitHint.Expression, argument, root)
      ),
    ).toEqual(["flag", "__cfLift_1(...)", "false"]);
    expect(diagnostics).toEqual([]);
  });

  it("lifts nothing and reports the hoist diagnostic for the same computation written bare", async () => {
    const { diagnostics, root } = await compileBinding("users.length === 0");

    expect(callsNamed(root, "ifElse")).toEqual([]);
    expect(callsMatching(root, /^__cfLift_/)).toEqual([]);
    expect(diagnostics.map(({ type, severity }) => ({ type, severity })))
      .toEqual([
        { type: "reactive:call-argument-computation", severity: "error" },
      ]);
  });
});

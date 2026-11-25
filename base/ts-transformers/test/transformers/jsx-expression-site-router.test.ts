import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import {
  callsMatching,
  callsNamed,
  collect,
  iifeCalls,
  parseModule,
} from "../transformed-ast.ts";
import { transformSource } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("jsx-expression-site-router", () => {
  it("leaves a non-reactive ternary over a whole-branch function as authored", async () => {
    // The ternary routes to the pre-closure rewrite because its branch is a
    // whole-branch function, but nothing in it is reactive, so the rewrite
    // produces nothing and the expression keeps its authored shape.
    const output = parseModule(
      await transformSource(
        `/// <cts-enable />
import { pattern, UI } from "commonfabric";
const on = true as boolean;
export default pattern<{ count: number }>(() => {
  return {
    [UI]: <div>{on ? (() => { const x = 1; return <b>{x}</b>; })() : <i />}</div>,
  };
});`,
        { types: COMMONFABRIC_TYPES },
      ),
    );

    expect(callsNamed(output, "ifElse")).toEqual([]);
    expect(callsMatching(output, /^__cfLift/)).toEqual([]);
    const ternaries = collect(output, ts.isConditionalExpression);
    expect(ternaries).toHaveLength(1);
    expect(iifeCalls(ternaries[0]!)).toHaveLength(1);
  });

  it("lowers the same ternary to `ifElse` when its condition is reactive", async () => {
    const output = parseModule(
      await transformSource(
        `/// <cts-enable />
import { pattern, UI } from "commonfabric";
export default pattern<{ on: boolean }>(({ on }) => {
  return {
    [UI]: <div>{on ? (() => { const x = 1; return <b>{x}</b>; })() : <i />}</div>,
  };
});`,
        { types: COMMONFABRIC_TYPES },
      ),
    );

    expect(callsNamed(output, "ifElse")).toHaveLength(1);
    expect(collect(output, ts.isConditionalExpression)).toEqual([]);
  });
});

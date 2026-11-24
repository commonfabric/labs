import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, collect, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("tagged enumeration branches", () => {
  it("preserves an authored symbol-less lowered-method callback", async () => {
    const output = parseModule(
      await transformSource(
        `
      import {pattern} from "commonfabric";
      declare const receiver: any;
      export default pattern<{n: number}>(({n}) => ({
        output: receiver.mapWithPattern((row: number) => row + n, {}),
      }));
    `,
        { types: COMMONFABRIC_TYPES },
      ),
    );
    const calls = callsNamed(output, "mapWithPattern");
    expect(calls).toHaveLength(1);
    expect(ts.isArrowFunction(calls[0].arguments[0])).toBe(true);
    expect(ts.isObjectLiteralExpression(calls[0].arguments[1])).toBe(true);
    expect(callsNamed(output, "pattern")).toHaveLength(1);
  });

  it("evaluates an enumerated discriminator inside a computation", async () => {
    const source = `
      import {pattern, GroupIndex, Cell} from "commonfabric";
      export default pattern<{index: GroupIndex<string | Cell<string>, {title: string}>}>(({index}) => ({
        values: index.keyEntries().map(entry => entry.kind === "cell"
          ? index.lookup(entry.cell).map(row => row.title).join(",")
          : index.lookup(entry.value).map(row => row.title).join(",")),
      }));
    `;
    const output = parseModule(
      await transformSource(source, { types: COMMONFABRIC_TYPES }),
    );
    const branches = callsNamed(output, "ifElse");
    expect(branches.length).toBeGreaterThan(0);
    expect(
      branches.flatMap((call) => [...call.arguments]).filter(
        ts.isBinaryExpression,
      ),
    ).toHaveLength(0);
    const comparisons = collect(output, ts.isBinaryExpression).filter((node) =>
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isStringLiteral(node.right) && node.right.text === "cell"
    );
    expect(comparisons.length).toBeGreaterThan(0);
    for (const comparison of comparisons) {
      let ancestor: ts.Node | undefined = comparison.parent;
      while (
        ancestor && !ts.isArrowFunction(ancestor) &&
        !ts.isFunctionExpression(ancestor)
      ) ancestor = ancestor.parent;
      expect(ancestor).toBeDefined();
      expect(ts.isPropertyAccessExpression(comparison.left)).toBe(true);
    }
  });

  it("keeps ordinary and computed-owned callback branches as JavaScript", async () => {
    const output = parseModule(
      await transformSource(
        `
      import {pattern, computed} from "commonfabric";
      const ordinary = [{kind: "cell"}, {kind: "value"}].map(entry => entry.kind === "cell" ? 1 : 2);
      export default pattern<{rows: {kind: string}[]}>(({rows}) => ({
        ordinary,
        values: computed(() => rows.map(entry => entry.kind === "cell" ? 1 : 2)),
      }));
    `,
        { types: COMMONFABRIC_TYPES },
      ),
    );
    expect(callsNamed(output, "ifElse")).toHaveLength(0);
    expect(collect(output, ts.isConditionalExpression)).toHaveLength(2);
  });
});

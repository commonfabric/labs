import { assert, assertEquals } from "@std/assert";

import plugin from "../lint-plugins/no-node-get-text.ts";

interface Report {
  node: unknown;
  message: string;
}

function createRule(filename: string, reports: Report[]) {
  return plugin.rules["no-node-get-text"].create({
    filename,
    report(report: Report) {
      reports.push(report);
    },
  } as never);
}

Deno.test("no-node-get-text lint plugin reports bare getText calls", () => {
  const reports: Report[] = [];
  const rule = createRule("/src/transformer.ts", reports);
  const visitCall = rule.CallExpression;
  assert(visitCall);
  const node = {
    callee: {
      type: "MemberExpression",
      computed: false,
      property: { type: "Identifier", name: "getText" },
    },
    arguments: [],
  };

  visitCall(node as never);

  assertEquals(reports.length, 1);
  assertEquals(reports[0]!.node, node);
  assertEquals(
    reports[0]!.message,
    "Bare node.getText() throws on synthetic AST nodes. Use " +
      "getNodeText()/getExpressionText() from ast/utils.ts, or pass " +
      "a SourceFile.",
  );
});

Deno.test("no-node-get-text lint plugin ignores allowed forms", () => {
  const reports: Report[] = [];
  const rule = createRule("/src/transformer.ts", reports);
  const visitCall = rule.CallExpression;
  assert(visitCall);

  visitCall({
    callee: {
      type: "MemberExpression",
      computed: false,
      property: { type: "Identifier", name: "getText" },
    },
    arguments: [{}],
  } as never);
  visitCall({
    callee: {
      type: "MemberExpression",
      computed: true,
      property: { type: "Identifier", name: "getText" },
    },
    arguments: [],
  } as never);
  visitCall({
    callee: {
      type: "MemberExpression",
      computed: false,
      property: { type: "Identifier", name: "toString" },
    },
    arguments: [],
  } as never);

  assertEquals(reports, []);
});

Deno.test("no-node-get-text lint plugin skips test files", () => {
  const reports: Report[] = [];
  const rule = createRule("/src/test/transformer.test.ts", reports);

  assertEquals(rule, {});
  assertEquals(reports, []);
});

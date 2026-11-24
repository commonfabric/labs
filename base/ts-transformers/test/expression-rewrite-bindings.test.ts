import { assertEquals } from "@std/assert";
import ts from "typescript";

import { createBindingPlan } from "../src/transformers/expression-rewrite/bindings.ts";

function parseExpressions(source: string): ts.Expression[] {
  const sourceFile = ts.createSourceFile(
    "/bindings.ts",
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );
  const expressions: ts.Expression[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      expressions.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return expressions;
}

Deno.test("createBindingPlan assigns stable unique binding names", () => {
  const [first, second, third] = parseExpressions(`
    user.profile.name;
    user.profile.name;
    $invalid["field-name"];
  `);
  const plan = createBindingPlan([
    { expression: first! },
    { expression: second! },
    { expression: third! },
  ] as never);

  assertEquals(plan.usesObjectBinding, true);
  assertEquals(
    plan.entries.map((entry) => entry.propertyName),
    ["user_profile_name", "user_profile_name_1", "$invalid__field_name__"],
  );
  assertEquals(
    plan.entries.map((entry) => entry.paramName),
    ["_v1", "_v2", "_v3"],
  );
  assertEquals(plan.entries.map((entry) => entry.dataFlow.expression), [
    first,
    second,
    third,
  ]);
});

Deno.test("createBindingPlan keeps single captures as direct bindings", () => {
  const [expression] = parseExpressions("selected.id;");
  const plan = createBindingPlan([{ expression: expression! }] as never);

  assertEquals(plan.usesObjectBinding, false);
  assertEquals(plan.entries[0]!.propertyName, "selected_id");
  assertEquals(plan.entries[0]!.paramName, "_v1");
});

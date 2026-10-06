import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, hasKeyPathRead, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("inline producer projections", () => {
  for (const selection of [".nested", '["nested"]']) {
    it(`navigates ${selection} without evaluating the reactive producer twice`, async () => {
      const output = await transformSource(
        `
import { computed, pattern, resultOf } from "commonfabric";
export default pattern((input: { request: { nested: { field: string } } }) => ({
  value: computed(() => {
    const nested = resultOf(computed(() => input.request))${selection};
    return nested.field;
  }),
}));`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const root = parseModule(output);
      expect(hasKeyPathRead(root, "nested")).toBe(true);
      expect(hasKeyPathRead(root, "field", "nested")).toBe(true);
      const projections = callsNamed(root, "resultOf");
      expect(projections).toHaveLength(1);
      const producer = projections[0].arguments[0];
      if (!producer || !ts.isCallExpression(producer)) {
        throw new Error("Expected the projection to invoke its producer");
      }
      if (!ts.isIdentifier(producer.expression)) {
        throw new Error("Expected a hoisted reactive producer");
      }
      expect(callsNamed(root, producer.expression.text)).toHaveLength(1);
    });
  }

  it("keeps a materialized capture projection as an ordinary value read", async () => {
    const output = await transformSource(
      `
import { computed, pattern, resultOf } from "commonfabric";
export default pattern((input: { request: { nested: { field: string } } }) => ({
  value: computed(() => {
    const nested = resultOf(input.request).nested;
    return nested.field;
  }),
}));`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const root = parseModule(output);
    expect(hasKeyPathRead(root, "nested")).toBe(false);
    expect(hasKeyPathRead(root, "field", "nested")).toBe(false);
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callsNamed,
  collect,
  hasKeyPathRead,
  literalToValue,
  parseModule,
} from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("inline producer projections", () => {
  it("keeps native guard policies on serialized paths after capture renaming", async () => {
    const output = await transformSource(
      `
import { type AsyncResult, computed, hasError, pattern, resultOf } from "commonfabric";
const input_1 = "global";
export default pattern((input: { request: AsyncResult<{ name: string }> }) => {
  const request = input.request;
  const usable = resultOf(input.request);
  return { value: computed(() => {
    const input = "local";
    return hasError(request) ? request.errorMessage : usable.name + input + input_1;
  }) };
});`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const root = parseModule(output);
    const call = callsNamed(root, "lift").find((call) =>
      callsNamed(call.arguments[0], "hasError").length === 1
    );
    if (!call) throw new Error("Expected the native guard callback");
    const options = literalToValue(call.arguments[3]);
    expect(options).toMatchObject({
      unavailableInputPolicy: [{
        path: ["input", "request"],
        reasons: ["error"],
      }],
    });
    const callback = call.arguments[0];
    if (!ts.isArrowFunction(callback)) throw new Error("Expected an arrow");
    const binding = callback.parameters[0].name;
    if (!ts.isObjectBindingPattern(binding)) {
      throw new Error("Expected capture destructuring");
    }
    const parameter = binding.elements[0].name;
    if (!ts.isIdentifier(parameter)) throw new Error("Expected a binding name");
    expect(parameter.text).not.toBe("input");
    expect(parameter.text).not.toBe("input_1");
    const guard = callsNamed(callback.body, "hasError")[0].arguments[0];
    expect(collect(guard, ts.isIdentifier).map((node) => node.text))
      .toEqual([parameter.text, "request"]);
  });

  for (
    const declaration of [
      'const input_1 = { suffix: "global" };',
      'namespace input_1 { export const suffix = "global"; }',
    ]
  ) {
    it(`preserves a referenced global declared as ${declaration}`, async () => {
      const output = await transformSource(
        `
import { computed, pattern, resultOf } from "commonfabric";
${declaration}
export default pattern((input: { request: { name: string } }) => {
  const usable = resultOf(input.request);
  return { value: computed(() => {
    const input = "local";
    return usable.name + input + input_1.suffix;
  }) };
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const root = parseModule(output);
      const callback = callsNamed(root, "lift")[0].arguments[0];
      if (!ts.isArrowFunction(callback)) throw new Error("Expected an arrow");
      const binding = callback.parameters[0].name;
      if (!ts.isObjectBindingPattern(binding)) {
        throw new Error("Expected capture destructuring");
      }
      const parameter = binding.elements[0].name;
      if (!ts.isIdentifier(parameter)) {
        throw new Error("Expected a binding name");
      }
      expect(parameter.text).not.toBe("input");
      expect(parameter.text).not.toBe("input_1");
      const suffix = collect(callback.body, ts.isPropertyAccessExpression).find(
        (
          node,
        ) => node.name.text === "suffix",
      );
      expect(
        suffix && ts.isIdentifier(suffix.expression) && suffix.expression.text,
      )
        .toBe("input_1");
    });
  }

  it("rewrites captured JSX values without renaming local JSX values", async () => {
    const output = await transformSource(
      `
import { computed, pattern, resultOf } from "commonfabric";
export default pattern((input: { request: { name: string } }) => {
  const usable = resultOf(input.request);
  return { value: computed(() => {
    const input = "local";
    return <div title={usable.name}>{usable.name}{input}</div>;
  }) };
});`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const root = parseModule(output);
    const call = callsNamed(root, "lift").find((call) =>
      collect(call, ts.isJsxElement).length > 0
    );
    if (!call) throw new Error("Expected the JSX callback lift");
    const callback = call.arguments[0];
    if (!ts.isArrowFunction(callback)) throw new Error("Expected an arrow");
    const binding = callback.parameters[0].name;
    if (!ts.isObjectBindingPattern(binding)) {
      throw new Error("Expected capture destructuring");
    }
    const parameter = binding.elements[0].name;
    if (!ts.isIdentifier(parameter)) throw new Error("Expected a binding name");
    expect(parameter.text).not.toBe("input");
    const expressions = collect(callback.body, ts.isJsxExpression).map((
      node,
    ) => node.expression);
    expect(expressions).toHaveLength(3);
    for (const expression of expressions.slice(0, 2)) {
      if (!expression) throw new Error("Expected a remote JSX value");
      expect(collect(expression, ts.isIdentifier).map((node) => node.text))
        .toContain(parameter.text);
    }
    const local = expressions[2];
    expect(local && ts.isIdentifier(local) && local.text).toBe("input");
  });

  it("retains a projection handle when its source root is shadowed at the call site", async () => {
    const output = await transformSource(
      `
import { pattern, resultOf } from "commonfabric";
export default pattern((input: { request: { name: string } }) => {
  const usable = resultOf(input.request);
  return { value: ["local"].map((input) => usable.name + input) };
});`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const root = parseModule(output);
    const calls = callsNamed(root, "lift");
    expect(calls).toHaveLength(1);
    const schema = literalToValue(calls[0].arguments[1]);
    expect(schema).toMatchObject({
      required: ["usable", "input"],
      properties: {
        usable: { type: "object", required: ["name"] },
        input: { type: "string" },
      },
    });
    const callback = calls[0].arguments[0];
    if (!ts.isArrowFunction(callback)) throw new Error("Expected an arrow");
    expect(
      collect(callback.body, ts.isPropertyAccessExpression).map((
        node,
      ) => ts.isIdentifier(node.expression) && node.expression.text),
    )
      .toEqual(["usable"]);
    const invocation = callsNamed(root, "map")[0].arguments[0];
    if (!ts.isArrowFunction(invocation)) {
      throw new Error("Expected the map callback");
    }
    const inputObject =
      collect(invocation.body, ts.isObjectLiteralExpression)[0];
    expect(
      inputObject.properties.map((property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.initializer) && property.initializer.text
      ),
    ).toEqual(["usable", "input"]);
  });

  it("keeps serialized capture keys separate from shadow-safe callback names", async () => {
    const output = await transformSource(
      `
import { computed, pattern, resultOf } from "commonfabric";
export default pattern((input: { request: { name: string } }) => {
  const usable = resultOf(input.request);
  return { value: computed(() => {
    const input = "local";
    const input_1 = "suffix";
    const snapshot = { usable };
    return snapshot.usable.name + input + input_1;
  }) };
});`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const root = parseModule(output);
    const call = callsNamed(root, "lift").find((call) => {
      const callback = call.arguments[0];
      return callback && ts.isArrowFunction(callback) &&
        collect(callback.body, ts.isVariableDeclaration).some((declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "snapshot"
        );
    });
    if (!call) throw new Error("Expected the captured projection callback");
    const callback = call.arguments[0];
    if (!ts.isArrowFunction(callback)) throw new Error("Expected an arrow");
    const binding = callback.parameters[0].name;
    if (!ts.isObjectBindingPattern(binding)) {
      throw new Error("Expected capture destructuring");
    }
    const input = binding.elements.find((element) =>
      element.propertyName && ts.isIdentifier(element.propertyName) &&
      element.propertyName.text === "input"
    );
    if (!input || !ts.isIdentifier(input.name)) {
      throw new Error("Expected a renamed input binding");
    }
    expect(input.name.text).not.toBe("input");
    expect(input.name.text).not.toBe("input_1");
    const snapshot = collect(callback.body, ts.isVariableDeclaration).find((
      declaration,
    ) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === "snapshot"
    );
    if (
      !snapshot?.initializer ||
      !ts.isObjectLiteralExpression(snapshot.initializer)
    ) {
      throw new Error("Expected the shorthand snapshot object");
    }
    const property = snapshot.initializer.properties[0];
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("Expected an expanded shorthand value");
    }
    expect(ts.isIdentifier(property.name) && property.name.text).toBe("usable");
    const receivers = collect(property.initializer, ts.isIdentifier).map((
      node,
    ) => node.text);
    expect(receivers).toContain(input.name.text);
    expect(receivers).not.toContain("input");
    const schema = literalToValue(call.arguments[1]);
    expect(schema).toMatchObject({
      type: "object",
      required: ["input"],
      properties: { input: { required: ["request"] } },
    });
  });

  it("navigates the projection of an already-bound reactive producer", async () => {
    const output = await transformSource(
      `
import { computed, pattern, resultOf } from "commonfabric";
export default pattern((input: { request: { nested: { field: string } } }) => {
  const request = computed(() => input.request);
  const nested = resultOf(request).nested;
  return { value: nested.field };
});`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const root = parseModule(output);
    expect(hasKeyPathRead(root, "nested")).toBe(true);
    expect(hasKeyPathRead(root, "field", "nested")).toBe(true);
    expect(callsNamed(root, "resultOf")).toHaveLength(1);
  });

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

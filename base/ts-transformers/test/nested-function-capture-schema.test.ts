import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const PRELUDE = `/// <cts-enable />
import { computed, lift, pattern } from "commonfabric";

function run<T>(f: () => T): T { return f(); }
`;

/**
 * The argument schema of the one `lift(...)` call whose callback's text
 * contains `marker`.
 */
async function liftArgumentSchema(
  source: string,
  marker: string,
): Promise<Record<string, unknown>> {
  const root = parseModule(
    await transformSource(PRELUDE + source, { types: COMMONFABRIC_TYPES }),
  );
  const calls = callsNamed(root, "lift").filter((call) => {
    const callback = call.arguments[0];
    return callback !== undefined && callback.getText(root).includes(marker);
  });
  expect(calls.length).toBe(1);
  const schema = calls[0]!.arguments.find((argument) =>
    ts.isSatisfiesExpression(argument)
  ) as ts.SatisfiesExpression | undefined;
  if (!schema) throw new Error(`The lift holding ${marker} has no schema`);
  return literalToValue(schema.expression) as Record<string, unknown>;
}

/** The property names `schema` declares. */
function propertyNames(schema: Record<string, unknown>): string[] {
  return Object.keys(schema.properties as Record<string, unknown>).sort();
}

describe("nested-function-capture-schema", () => {
  describe("a capture read inside a function nested in a computation", () => {
    it("is kept in a computed's input when read in a closure handed to a helper", async () => {
      const schema = await liftArgumentSchema(
        `export default pattern<{ label?: string; count: number }>(
    ({ label, count }) => ({
      v: computed(() => count >= 0 && run(() => label !== undefined)),
    }),
  );`,
        "run(",
      );

      expect(propertyNames(schema)).toEqual(["count", "label"]);
    });

    it("is kept in a computed's input when read in an immediately invoked function", async () => {
      const schema = await liftArgumentSchema(
        `export default pattern<{ label?: string; count: number }>(
    ({ label, count }) => ({
      v: computed(() => count >= 0 && (() => label !== undefined)()),
    }),
  );`,
        "count >= 0",
      );

      expect(propertyNames(schema)).toEqual(["count", "label"]);
    });

    it("is kept in an authored lift's input when read in a closure handed to a helper", async () => {
      const schema = await liftArgumentSchema(
        `const total = lift((input: { a: number; b: number }) =>
    input.a + run(() => input.b)
  );
  export default pattern<{ a: number; b: number }>(({ a, b }) => ({
    v: total({ a, b }),
  }));`,
        "input.a",
      );

      expect(propertyNames(schema)).toEqual(["a", "b"]);
    });

    it("is kept in an authored lift's input when read in a nested function's default parameter", async () => {
      const schema = await liftArgumentSchema(
        `const total = lift((input: { a: number; b: number }) => {
  function f(x = input.b) {
    return input.a + x;
  }
  return f();
});
export default pattern<{ a: number; b: number }>(({ a, b }) => ({
  v: total({ a, b }),
}));`,
        "function f(",
      );

      expect(propertyNames(schema)).toEqual(["a", "b"]);
    });

    it("is kept in an authored lift's input when read in a destructured default of a nested arrow", async () => {
      const schema = await liftArgumentSchema(
        `const total = lift((input: { a: number; c: { y: number } }) => {
  const g = ({ y } = input.c) => input.a + y;
  return g();
});
export default pattern<{ a: number; c: { y: number } }>(({ a, c }) => ({
  v: total({ a, c }),
}));`,
        "const g = ",
      );

      expect(propertyNames(schema)).toEqual(["a", "c"]);
    });

    it("is kept in an authored lift's input when read in a computed key of a nested function's parameter", async () => {
      const schema = await liftArgumentSchema(
        `const total = lift((input: { a: number; k: string }) => {
  function f({ [input.k]: x }: Record<string, number>) {
    return input.a + (x ?? 0);
  }
  return f({ b: 2 });
});
export default pattern<{ a: number; k: string }>(({ a, k }) => ({
  v: total({ a, k }),
}));`,
        "function f(",
      );

      expect(propertyNames(schema)).toEqual(["a", "k"]);
    });

    it("still narrows the input to the members the nested function reads", async () => {
      const schema = await liftArgumentSchema(
        `const pick = lift((input: { a: number; b: { x: number; y: number } }) =>
    input.a + run(() => input.b.x)
  );
  export default pattern<{ a: number; b: { x: number; y: number } }>(
    ({ a, b }) => ({ v: pick({ a, b }) }),
  );`,
        "input.b.x",
      );

      const b = (schema.properties as Record<string, Record<string, unknown>>)
        .b!;
      expect(propertyNames(schema)).toEqual(["a", "b"]);
      expect(propertyNames(b)).toEqual(["x"]);
    });
  });
});

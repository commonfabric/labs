import { assertEquals, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

function getOpaqueGetErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) =>
    d.type === "opaque-get:invalid-call" && d.severity === "error"
  );
}

Deno.test(
  "opaque-get flags .get() on a destructured pattern-callback parameter",
  async () => {
    // isReactiveExpression: identifier bound to a pattern-callback parameter is
    // a reactive value, so calling .get() on it (via a structural fallback, not
    // a branded type) is flagged as an invalid opaque .get() call.

    const source = `      import { pattern } from "commonfabric";

      interface State { title: string; }

      export default pattern<State>(({ title }) => {
        const t = title.get();
        return { t };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(
      errors[0]!.message,
      "is a reactive value that can be accessed directly",
    );
  },
);

Deno.test(
  "opaque-get flags .get() on a member of the whole pattern input parameter",
  async () => {
    // isPatternCallbackParameter: the whole pattern input parameter (not
    // destructured) is reactive, so member access rooted at it and then .get()
    // is flagged. This drives the walk up to the enclosing function and its
    // builder call.

    const source = `      import { pattern } from "commonfabric";

      interface State { nested: { value: number }; }

      export default pattern<State>((state) => {
        const v = state.nested.get();
        return { v };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "reactive value");
  },
);

Deno.test(
  "opaque-get flags .get() on a local initialized from computed()",
  async () => {
    // isReactiveInitializer: a local variable initialized directly from a
    // reactive-origin call (computed()) is reactive; .get() on it is flagged.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ count: number }>(({ count }) => {
        const doubled = computed(() => count * 2);
        const bad = doubled.get();
        return { bad };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "computed()");
  },
);

Deno.test(
  "opaque-get flags .get() on a local initialized from a wrapped reactive-origin call",
  async () => {
    // isReactiveInitializer unwrapping: the reactive-origin call is wrapped in
    // a parenthesized / non-null / property-access chain before assignment, and
    // the validator peels those layers off to find the origin call underneath.

    const source = `      import { computed, pattern } from "commonfabric";

      interface Shape { inner: number; }

      export default pattern<{ count: number }>(({ count }) => {
        const wrapped = (computed(() => ({ inner: count } as Shape)))!.inner;
        const bad = wrapped.get();
        return { bad };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "reactive value");
  },
);

Deno.test(
  "opaque-get flags .get() on a local initialized through each wrapper spelling",
  async () => {
    // isReactiveInitializer reads the shared transparent-wrapper set, so every
    // spelling that wraps the origin call without changing it reaches the same
    // diagnostic. `satisfies` is the spelling most easily left out of a
    // hand-written wrapper list, so it is pinned here alongside its neighbours.

    const initializers = [
      "computed(() => count * 2)",
      "(computed(() => count * 2))",
      "computed(() => count * 2)!",
      "computed(() => count * 2) as never",
      "computed(() => count * 2) satisfies unknown",
      "(computed(() => count * 2) satisfies unknown)",
    ];

    for (const initializer of initializers) {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ count: number }>(({ count }) => {
        const doubled = ${initializer};
        const bad = doubled.get();
        return { bad };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getOpaqueGetErrors(diagnostics);
      assertEquals(
        errors.length,
        1,
        `expected one opaque-get error for initializer: ${initializer}`,
      );
    }
  },
);

Deno.test(
  "opaque-get flags .get() on a binding destructured from a reactive local",
  async () => {
    // isReactiveExpression binding-element branch: a value destructured out of
    // a local whose initializer is a reactive-origin call is still reactive, so
    // .get() on the destructured binding is flagged.

    const source = `      import { computed, pattern } from "commonfabric";

      interface Shape { a: number; b: number; }

      export default pattern<{ count: number }>(({ count }) => {
        const { a } = computed(() => ({ a: count, b: count } as Shape));
        const bad = a.get();
        return { bad };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "reactive value");
  },
);

Deno.test(
  "opaque-get flags .get() when the pattern callback is parenthesized",
  async () => {
    // isPatternCallbackParameter walks up from the enclosing function to its
    // builder call. When the callback is wrapped in parentheses, the function's
    // immediate parent is not the call expression, so the walk climbs through
    // the parenthesized wrapper before reaching pattern(). The .get() on the
    // reactive input must still be flagged.

    const source = `      import { pattern } from "commonfabric";

      interface State { title: string; }

      export default pattern<State>(((state) => {
        const t = state.title.get();
        return { t };
      }));
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!.message, "reactive value");
  },
);

Deno.test(
  "opaque-get does not flag .get() on an unresolvable identifier",
  async () => {
    // isReactiveExpression bails out when the receiver identifier has no
    // resolved symbol: an unresolvable receiver cannot be proven reactive, so
    // no opaque-get diagnostic is produced for it (the structural fallback
    // returns false at the missing-symbol guard).

    const source = `      import { pattern } from "commonfabric";

      export default pattern(() => {
        // @ts-ignore intentional unresolved reference
        const v = undeclaredThing.get();
        return { v };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 0);
  },
);

Deno.test(
  "opaque-get does not flag .get() on a Writable cell",
  async () => {
    // A .get() on a genuine Cell/Writable must NOT be flagged by this
    // validator: cellKind === "cell" returns early, exercising the non-reactive
    // path.

    const source = `      import { pattern, Cell } from "commonfabric";

      export default pattern<{ count: Cell<number> }>(({ count }) => {
        const v = count.get();
        return { v };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getOpaqueGetErrors(diagnostics);
    assertEquals(errors.length, 0);
  },
);

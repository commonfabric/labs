import { assertEquals, assertGreater, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

function getErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.severity === "error");
}

function errorsOfType(
  diagnostics: readonly TransformationDiagnostic[],
  type: string,
) {
  return getErrors(diagnostics).filter((d) => d.type === type);
}

Deno.test(
  "computation over reactive property in statement position names the access",
  async () => {
    // validateComputationExpression -> findProblematicAccess: a reactive
    // property access used in a bare statement-position arithmetic computation
    // is at a restricted (non-lowerable) site, so it is rejected with
    // pattern-context:computation. findProblematicAccess locates the first
    // property access ('input.a') and names it in the message.

    const source = `      import { pattern } from "commonfabric";

      export default pattern<{ a: number }>((input) => {
        input.a + 1;
        return input;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(diagnostics, "pattern-context:computation");
    assertGreater(errors.length, 0, "Expected a computation error");
    assertStringIncludes(errors[0]!.message, "'input.a'");
  },
);

Deno.test(
  "if-condition over locally created computed result is rejected",
  async () => {
    // validateLocalReactiveAliasUsage: an if-statement condition that reads a
    // reactive value created locally inside the enclosing computed() callback
    // is rejected with compute-context:local-reactive-use, and the message
    // tells the author to move the use into a nested computed().

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const outer = computed(() => {
          const flag = computed(() => true);
          if (flag) {
            return 1;
          }
          return 0;
        });
        return { outer };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(
      diagnostics,
      "compute-context:local-reactive-use",
    );
    assertGreater(errors.length, 0, "Expected a local-reactive-use error");
    assertStringIncludes(errors[0]!.message, "nested computed(() => ...)");
  },
);

Deno.test(
  "while/for/switch heads over locally created computed results are rejected",
  async () => {
    // validateLocalReactiveAliasUsage while/for/switch statement heads: reading
    // a locally created reactive value in a while/for/switch head is rejected
    // the same way as an if-condition.

    const whileSource = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const outer = computed(() => {
          const flag = computed(() => true);
          while (flag) {
            return 1;
          }
          return 0;
        });
        return { outer };
      });
    `;
    const forSource = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const outer = computed(() => {
          const limit = computed(() => 3);
          for (let i = 0; i < limit; i++) {
            return i;
          }
          return 0;
        });
        return { outer };
      });
    `;
    const switchSource =
      `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const outer = computed(() => {
          const which = computed(() => 1);
          switch (which) {
            case 1:
              return "a";
            default:
              return "b";
          }
        });
        return { outer };
      });
    `;
    for (const source of [whileSource, forSource, switchSource]) {
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = errorsOfType(
        diagnostics,
        "compute-context:local-reactive-use",
      );
      assertGreater(
        errors.length,
        0,
        "Expected a local-reactive-use error for statement head",
      );
    }
  },
);

Deno.test(
  "member access on a locally created reactive result is rejected",
  async () => {
    // findProblematicUse member-access branch: a topmost property access rooted
    // at a locally created reactive value (`local.flag`) is itself the culprit,
    // so reading it in an if-condition is rejected.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ obj: { flag: boolean } }>(({ obj }) => {
        const outer = computed(() => {
          const local = computed(() => obj);
          if (local.flag) {
            return 1;
          }
          return 0;
        });
        return { outer };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(
      diagnostics,
      "compute-context:local-reactive-use",
    );
    assertGreater(errors.length, 0, "Expected a local-reactive-use error");
  },
);

Deno.test(
  "opaque-source call on a locally created reactive result is rejected",
  async () => {
    // findProblematicUse call branch: a `.get()`/`.key()`/`.for()` chain on a
    // locally created reactive value is a provenance-preserving opaque-source
    // call, so using it in an if-condition is rejected as a local reactive use.

    const source =
      `      import { computed, pattern, Cell } from "commonfabric";

      export default pattern<{ cell: Cell<number> }>(({ cell }) => {
        const outer = computed(() => {
          const local = computed(() => cell);
          if (local.get()) {
            return 1;
          }
          return 0;
        });
        return { outer };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(
      diagnostics,
      "compute-context:local-reactive-use",
    );
    assertGreater(errors.length, 0, "Expected a local-reactive-use error");
  },
);

Deno.test(
  "for-statement without a condition still reports the local reactive use",
  async () => {
    // checkExpression skips a missing expression: a for-statement with no
    // condition (`for (;;)`) passes an undefined condition to checkExpression,
    // which returns early. The loop body still reports the local reactive use
    // inside it.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const outer = computed(() => {
          const flag = computed(() => true);
          for (;;) {
            if (flag) {
              return 1;
            }
          }
        });
        return { outer };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(
      diagnostics,
      "compute-context:local-reactive-use",
    );
    assertGreater(errors.length, 0, "Expected a local-reactive-use error");
  },
);

Deno.test(
  "condition with a nested callback still reports the local reactive use",
  async () => {
    // findProblematicUse nested-function skip: when the checked expression
    // contains a nested callback (an array-method arrow), the walk does not
    // descend into that nested function, but still finds the local reactive use
    // in the surrounding condition.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ items: number[] }>(({ items }) => {
        const outer = computed(() => {
          const local = computed(() => items);
          if ([1, 2].some((n) => n > 0) && local.length > 0) {
            return 1;
          }
          return 0;
        });
        return { outer };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(
      diagnostics,
      "compute-context:local-reactive-use",
    );
    assertGreater(errors.length, 0, "Expected a local-reactive-use error");
  },
);

Deno.test(
  "toJSON member on a pattern object literal is rejected",
  async () => {
    // validateObjectMemberCreation: `toJSON` is an ordinary member name, so a
    // method carrying it is rejected like any other object-literal method --
    // the data model stores no function-valued member whatever it is called.

    const source = `      import { pattern, UI } from "commonfabric";

      export default pattern<{ name: string }>(({ name }) => {
        const wrapper = {
          toJSON() {
            return { value: name };
          },
        };
        return { [UI]: <div />, wrapper };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected an error for a toJSON member");
  },
);

Deno.test(
  "standalone function calling computed() is rejected",
  async () => {
    // validateStandaloneFunction: a standalone (module-scope) function that
    // calls a reactive-origin builder like computed() is rejected, since
    // standalone functions cannot capture reactive closures.

    const source = `      import { computed } from "commonfabric";

      export function makeDoubled(n: number) {
        return computed(() => n * 2);
      }
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(
      diagnostics,
      "standalone-function:reactive-operation",
    );
    assertGreater(errors.length, 0, "Expected standalone reactive error");
    assertStringIncludes(errors[0]!.message, "standalone functions");
  },
);

Deno.test(
  "standalone function calling a reactive array method is rejected",
  async () => {
    // validateStandaloneFunction reactive-array-method branch: a standalone
    // function that calls a reactive array method (.map on a Cell array) is
    // rejected, and the message names the offending method family.

    const source = `      import { Cell } from "commonfabric";

      export function run(items: Cell<number[]>) {
        return items.map((n) => n + 1);
      }
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(
      diagnostics,
      "standalone-function:reactive-operation",
    );
    assertGreater(errors.length, 0, "Expected standalone reactive error");
    assertStringIncludes(errors[0]!.message, "map");
  },
);

Deno.test(
  "callback parameter default initializer capturing a helper is flagged",
  async () => {
    // validateCallbackSelfContainment with a parameter default initializer that
    // references an enclosing callable: the initializer is visited and the
    // capture is flagged.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const helper = (value: string) => value.toUpperCase();
          const inner = computed((seed = helper) => seed("x"));
          return inner;
        });
        return { label };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(diagnostics, "ses-callback:callable-capture");
    assertGreater(errors.length, 0, "Expected a callable-capture error");
  },
);

Deno.test(
  "capturing a non-callable uninitialized local is not flagged",
  async () => {
    // isCallableReference non-callable-capture path: a captured uninitialized
    // local (a `let` with a non-function type, no initializer) is neither a
    // call use-site nor an inference-checkable binding, so the validator
    // classifies it as non-callable and does NOT emit a callable-capture
    // diagnostic for it.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          let x: number;
          x = 5;
          return computed(() => ({ x }));
        });
        return { label };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(diagnostics, "ses-callback:callable-capture");
    assertEquals(
      errors.length,
      0,
      "Non-callable capture should not be flagged",
    );
  },
);

Deno.test(
  "callback capturing a function-typed parameter is flagged",
  async () => {
    // isSyntacticCallable parameter-type branch -> isCallableTypeNode: a
    // callback whose parameter is explicitly typed as a function type (with no
    // initializer, so the type node is inspected rather than an initializer) is
    // callable, and capturing that parameter inside a nested computed callback
    // is flagged. This exercises isCallableTypeNode's plain function-type
    // branch.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const run = (cb: (v: string) => string) => {
            return computed(() => ({ cb }));
          };
          return run((v) => v);
        });
        return { label };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(diagnostics, "ses-callback:callable-capture");
    assertGreater(errors.length, 0, "Expected a callable-capture error");
  },
);

Deno.test(
  "callback capturing a parenthesized-function-typed parameter is flagged",
  async () => {
    // isCallableTypeNode parenthesized-type branch: a parameter typed with a
    // parenthesized function type unwraps to the inner function type and is
    // recognized as callable, so capturing it is flagged.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const run = (cb: ((v: string) => string)) => computed(() => ({ cb }));
          return run((v) => v);
        });
        return { label };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(diagnostics, "ses-callback:callable-capture");
    assertGreater(errors.length, 0, "Expected a callable-capture error");
  },
);

Deno.test(
  "callback capturing a union-function-typed parameter is flagged",
  async () => {
    // isCallableTypeNode union-type branch: a parameter typed as a union that
    // contains a function type has at least one callable member, so capturing
    // it is flagged.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const run = (cb: ((v: string) => string) | undefined) =>
            computed(() => ({ cb }));
          return run((v) => v);
        });
        return { label };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(diagnostics, "ses-callback:callable-capture");
    assertGreater(errors.length, 0, "Expected a callable-capture error");
  },
);

Deno.test(
  "callback capturing an intersection-function-typed parameter is flagged",
  async () => {
    // isCallableTypeNode intersection-type branch: a parameter typed as an
    // intersection that contains a function type has a callable member, so
    // capturing it is flagged.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const run = (cb: ((v: string) => string) & { tag: string }) =>
            computed(() => ({ cb }));
          return run(Object.assign((v: string) => v, { tag: "t" }));
        });
        return { label };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(diagnostics, "ses-callback:callable-capture");
    assertGreater(errors.length, 0, "Expected a callable-capture error");
  },
);

Deno.test(
  "callback capturing a Function-typed parameter is flagged",
  async () => {
    // isCallableTypeNode Function-reference branch: a parameter typed as the
    // global Function type is recognized as callable by its type reference
    // name, so capturing it is flagged.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const run = (cb: Function) => computed(() => ({ cb }));
          return run((v: string) => v);
        });
        return { label };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(diagnostics, "ses-callback:callable-capture");
    assertGreater(errors.length, 0, "Expected a callable-capture error");
  },
);

Deno.test(
  "a helper captured multiple times is reported once",
  async () => {
    // report() dedup: when a single captured helper is referenced multiple
    // times in one callback, the callable-capture diagnostic is emitted only
    // once (keyed by identifier text), exercising the diagnosticsSeen guard.

    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const helper = (v: string) => v.toUpperCase();
          return computed(() => helper("a") + helper("b"));
        });
        return { label };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = errorsOfType(diagnostics, "ses-callback:callable-capture");
    assertEquals(
      errors.length,
      1,
      "Expected exactly one callable-capture error",
    );
  },
);

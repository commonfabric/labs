/**
 * Verb contract WS-C/C2: a block body containing `return <expr>` under a
 * void-declared verb is a transformer error pointing the author at declaring
 * the result; concise arrow completion values stay silently absorbed (the
 * recorded no-inference decision), and bare `return;` stays control flow.
 *
 * These sources compile against the REAL commonfabric surface
 * (`COMMONFABRIC_TYPES` loads `types/commonfabric.d.ts`, generated from
 * `base/api/index.ts`), so the declared-result cases also prove the
 * `action<E, R>` / `handler<E, T, R>` overloads are reachable from a pattern.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

function undeclaredReturnErrors(
  diagnostics: readonly TransformationDiagnostic[],
) {
  return diagnostics.filter(
    (d) => d.type === "verb-result:undeclared-return" && d.severity === "error",
  );
}

async function errorsIn(patternBody: string) {
  const source = `
    import { action, cell, handler, navigateTo, pattern } from "commonfabric";
    export default pattern(() => {
      const selected = cell("");
      ${patternBody}
      return { verb, selected };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return undeclaredReturnErrors(diagnostics);
}

Deno.test("explicit return under a void-declared action errors", async () => {
  const errors = await errorsIn(`
    const verb = action((id: string) => {
      return { picked: id };
    });
  `);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0].message, "action<Event, Result>");
  assertStringIncludes(errors[0].message, "nothing tells a caller");
});

Deno.test("a declared result makes the same body legal", async () => {
  const errors = await errorsIn(`
    const verb = action<string, { picked: string }>((id) => {
      return { picked: id };
    });
  `);
  assertEquals(errors.length, 0);
});

Deno.test("an explicit void declaration still counts as value-less", async () => {
  const errors = await errorsIn(`
    const verb = action<string, void>((id) => {
      return { picked: id };
    });
  `);
  assertEquals(errors.length, 1);
});

Deno.test("concise arrow completion values stay silently absorbed", async () => {
  // `Cell.set` returns the cell; nobody wrote a verb result here. This is the
  // recorded no-inference decision, and it must never trip the guard.
  const errors = await errorsIn(`
    const verb = action((id: string) => selected.set(id));
  `);
  assertEquals(errors.length, 0);
});

Deno.test("bare return and `return undefined` are control flow", async () => {
  const errors = await errorsIn(`
    const verb = action((id: string) => {
      if (id.length === 0) return;
      if (id.length > 100) return undefined;
      selected.set(id);
    });
  `);
  assertEquals(errors.length, 0);
});

Deno.test("returns inside nested functions belong to their own callers", async () => {
  const errors = await errorsIn(`
    const verb = action((id: string) => {
      const label = [id].map((part) => {
        return part.toUpperCase();
      });
      selected.set(label[0]);
    });
  `);
  assertEquals(errors.length, 0);
});

Deno.test("each offending return is reported", async () => {
  const errors = await errorsIn(`
    const verb = action((id: string) => {
      if (id.length === 0) {
        return { picked: "" };
      }
      return { picked: id };
    });
  `);
  assertEquals(errors.length, 2);
});

Deno.test("explicit return under a void-declared handler errors, on every call form", async () => {
  const typed = await errorsIn(`
    const verb = handler((id: string, _state: { note: string }) => {
      return { picked: id };
    });
  `);
  assertEquals(typed.length, 1);
  assertStringIncludes(typed[0].message, "handler<Event, State, Result>");

  const schemas = await errorsIn(`
    const verb = handler(
      { type: "object" },
      { type: "object" },
      (id: string, _state: { note: string }) => {
        return { picked: id };
      },
    );
  `);
  assertEquals(schemas.length, 1);
});

Deno.test("calls and identifiers are the launch idiom, not a dropped result", async () => {
  // Returning navigateTo(...), a freshly created piece, or any other call /
  // identifier is consumed by the runtime's reactive branch with or without
  // a declared result — real patterns (notebook's create-and-return actions)
  // rely on it. Types cannot discriminate (the authored surface renders
  // Reactive<T> transparently), so non-literal shapes are never judged.
  const cellReturn = await errorsIn(`
    const verb = action((id: string) => {
      selected.set(id);
      return selected;
    });
  `);
  assertEquals(cellReturn.length, 0);

  const navigate = await errorsIn(`
    const verb = action((id: string) => {
      return navigateTo(selected);
    });
  `);
  assertEquals(navigate.length, 0);
});

Deno.test("plain-shaped returns error: templates and concatenation", async () => {
  const template = await errorsIn(`
    const verb = action((id: string) => {
      return \`picked-\${id}\`;
    });
  `);
  assertEquals(template.length, 1);

  const concat = await errorsIn(`
    const verb = action((id: string) => {
      return "picked-" + id;
    });
  `);
  assertEquals(concat.length, 1);
});

Deno.test("signed numeric literals are plain-shaped", async () => {
  const negative = await errorsIn(`
    const verb = action((id: string) => {
      if (id.length === 0) {
        return -1;
      }
      selected.set(id);
    });
  `);
  assertEquals(negative.length, 1);

  // Unary over a non-plain operand stays unjudged, like the operand itself.
  const negatedRead = await errorsIn(`
    const verb = action((id: string) => {
      return -id.length;
    });
  `);
  assertEquals(negatedRead.length, 0);
});

Deno.test("an any-assertion opts the return out (fail-open)", async () => {
  const errors = await errorsIn(`
    const verb = action((id: string) => {
      return { picked: id } as any;
    });
  `);
  assertEquals(errors.length, 0);
});

Deno.test("verbs authored inline in JSX attributes are judged too", async () => {
  // The stock ts.visitEachChild skips JsxExpression.expression (the repo's
  // documented visitor trap); the JSX-aware visitor keeps the guard honest
  // for verbs written directly in attributes.
  const source = `
    import { action, cell, pattern } from "commonfabric";
    export default pattern(() => {
      const selected = cell("");
      return {
        ui: (
          <button
            type="button"
            onClick={action((id: string) => {
              return { picked: id };
            })}
          >
            Pick
          </button>
        ),
        selected,
      };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  assertEquals(undeclaredReturnErrors(diagnostics).length, 1);
});

Deno.test("a handler declaring its result is legal", async () => {
  const errors = await errorsIn(`
    const verb = handler<string, { note: string }, { picked: string }>(
      (id, _state) => {
        return { picked: id };
      },
    );
  `);
  assertEquals(errors.length, 0);
});

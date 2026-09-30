/// <reference lib="deno.unstable" />

/**
 * A lint rule that stops the CI tasks under `tasks/` from spreading a
 * collection into a call that takes one argument per element.
 *
 * `records.push(...more)` passes every element of `more` as a separate
 * argument, and V8 limits how many arguments one call can take: past roughly a
 * hundred thousand, the call throws `RangeError: Maximum call stack size
 * exceeded`. The tasks here hold collections that grow with the number of tests
 * a run has — test records, the findings about them, the objects a store
 * listing returns — so a spread that is safe on the day it is written fails
 * later, in CI, once a run grows past the limit.
 *
 * The rule reports a spread argument to a method named `push`, `unshift`, or
 * `splice`, whatever it is called on, and to `Math.max`, `Math.min`,
 * `String.fromCharCode`, and `String.fromCodePoint`. Those are the calls whose
 * purpose is to take a whole collection as arguments. A spread into any other
 * call, such as `path.join(root, ...segments)`, forwards a list whose length
 * the code fixes, and is left alone. So is a spread into an array literal,
 * which V8 builds without passing arguments.
 */

/** The methods reported whatever object they are called on. */
const METHODS: ReadonlySet<string> = new Set(["push", "splice", "unshift"]);

/** The functions reported when called on the global named by the key. */
const FUNCTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Math", new Set(["max", "min"])],
  ["String", new Set(["fromCharCode", "fromCodePoint"])],
]);

/** The directory this rule applies to, which is the one this file is in. */
const TASKS = import.meta.dirname!;

const MESSAGE =
  "Spreading a collection into this call passes each element as a separate " +
  "argument, and V8 throws `RangeError: Maximum call stack size exceeded` " +
  "once a call has more than about a hundred thousand of them. Append in a " +
  "loop (`for (const item of items) out.push(item);`), and take the " +
  "largest or smallest with `maxOf` or `minOf` from " +
  "`@commonfabric/utils/math`. See docs/development/DEVELOPMENT.md, " +
  '"Spreading a collection into a call".';

/** The name of an identifier, or undefined for any other node. */
function nameOf(node: Deno.lint.Node): string | undefined {
  return node.type === "Identifier" ? node.name : undefined;
}

/** Returns true when `callee` is one of the calls this rule reports. */
function takesCollection(callee: Deno.lint.Node): boolean {
  // `held?.push(...)` wraps its callee in a `ChainExpression`.
  if (callee.type === "ChainExpression") callee = callee.expression;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const method = nameOf(callee.property);
  if (method === undefined) return false;
  if (METHODS.has(method)) return true;
  const object = nameOf(callee.object);
  return object !== undefined && FUNCTIONS.get(object)?.has(method) === true;
}

export default {
  name: "cf-tasks",
  rules: {
    "no-spread-arguments": {
      create(context) {
        if (!context.filename.startsWith(`${TASKS}/`)) return {};
        return {
          CallExpression(node) {
            if (!takesCollection(node.callee)) return;
            for (const argument of node.arguments) {
              if (argument.type !== "SpreadElement") continue;
              // The node of a spread covers only its `...`, so the report
              // runs on to the end of the collection it spreads.
              const range: Deno.lint.Range = [
                argument.range[0],
                argument.argument.range[1],
              ];
              context.report({ range, message: MESSAGE });
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;

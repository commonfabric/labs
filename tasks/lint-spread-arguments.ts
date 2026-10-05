/// <reference lib="deno.unstable" />

/**
 * A lint rule that stops code from spreading a collection into a call that
 * takes one argument per element.
 *
 * `records.push(...more)` passes every element of `more` as a separate
 * argument, and V8 limits how many arguments one call can take: past roughly a
 * hundred thousand, the call throws `RangeError: Maximum call stack size
 * exceeded`. A collection that grows with data — test records, the changes a
 * cell write makes, the lines of a file — makes a spread that is safe on the
 * day it is written fail later, once the data grows past the limit. The rule
 * cannot tell such a collection from one whose size the code fixes, so it
 * reports both.
 *
 * The rule reports a spread argument to a method named `push`, `unshift`, or
 * `splice`, whatever it is called on, and to `Math.max`, `Math.min`,
 * `String.fromCharCode`, and `String.fromCodePoint`. Those are the calls whose
 * purpose is to take a whole collection as arguments. A spread into any other
 * call, such as `path.join(root, ...segments)`, forwards a list whose length
 * the code fixes, and is left alone. So is a spread into an array literal,
 * which V8 builds without passing arguments. A spread that has to stay
 * carries a `deno-lint-ignore` comment saying why.
 */

/** The methods reported whatever object they are called on. */
const METHODS: ReadonlySet<string> = new Set(["push", "splice", "unshift"]);

/** The functions reported when called on the global named by the key. */
const FUNCTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Math", new Set(["max", "min"])],
  ["String", new Set(["fromCharCode", "fromCodePoint"])],
]);

const MESSAGE =
  "Spreading a collection into this call passes each element as a separate " +
  "argument, and V8 throws `RangeError: Maximum call stack size exceeded` " +
  "once a call has more than about a hundred thousand of them. Append in a " +
  "loop (`for (const item of items) out.push(item);`), or to an array cell " +
  "with `pushAll(items)`; take the largest or smallest with `maxOf` or " +
  "`minOf` from `@commonfabric/utils/math`; and replace a range with " +
  "`spliceAll` from `@commonfabric/utils/arrays`. See " +
  "docs/development/DEVELOPMENT.md, " +
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
  name: "cf-spread",
  rules: {
    "no-spread-arguments": {
      create(context) {
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

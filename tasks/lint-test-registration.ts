/// <reference lib="deno.unstable" />

/**
 * A lint rule that keeps every test registering through
 * `@commonfabric/test-support/test`.
 *
 * That module is what applies a run's skip list, records what each test file
 * registered and how each test went, and runs what a test package installs
 * around its suites. A test registered with `Deno.test`, or through
 * `@std/testing/bdd`, runs all the same but does none of that: a lane cannot
 * skip it, its runs are never recorded, and so test selection never learns
 * of it. The rule reports any use of `Deno.test` and any import of
 * `@std/testing/bdd`, and any `unload` event a program makes, which the
 * module would take for the end of its file. The module itself is the one
 * place that registers with `Deno.test`, and says so with an ignore comment.
 */

const DENO_TEST_MESSAGE = "Register a test with `test()`, or a suite with " +
  "`describe()` and `it()`, from `@commonfabric/test-support/test`, rather " +
  "than with `Deno.test`. A test `Deno.test` registers is never skipped by a " +
  "lane's skip list and never recorded.";

const BDD_MESSAGE = "Import `describe`, `it` and the hooks from " +
  "`@commonfabric/test-support/test`, not from `@std/testing/bdd`. A test " +
  "`@std/testing/bdd` registers is never skipped by a lane's skip list and " +
  "never recorded.";

const UNLOAD_MESSAGE = "Do not make an `unload` event: the test module " +
  "takes one for the end of its test file, and records nothing after it. " +
  "Run code that runs at unload in a process of its own.";

/**
 * `@std/testing/bdd` however a specifier spells it: through the import map,
 * or straight from JSR, with or without a version.
 */
const BDD = /^(jsr:)?@std\/testing(@[^/]*)?\/bdd(\/|$)/;

/** The text a node spells out literally, if it spells out any. */
function textOf(node: Deno.lint.Node): string | undefined {
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : undefined;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.cooked ?? undefined;
  }
  return undefined;
}

/** Whether a node names `Deno.test`, dotted or bracketed. */
function isDenoTest(node: Deno.lint.MemberExpression): boolean {
  if (node.object.type !== "Identifier" || node.object.name !== "Deno") {
    return false;
  }
  const { property } = node;
  return node.computed
    ? property.type === "Literal" && property.value === "test"
    : property.type === "Identifier" && property.name === "test";
}

export default {
  name: "cf-test",
  rules: {
    "registration": {
      create(context) {
        const fromBdd = (
          node: Deno.lint.Node,
          source: Deno.lint.StringLiteral | null,
        ) => {
          if (source !== null && BDD.test(source.value)) {
            context.report({ node, message: BDD_MESSAGE });
          }
        };
        return {
          MemberExpression(node) {
            if (isDenoTest(node)) {
              context.report({ node, message: DENO_TEST_MESSAGE });
            }
          },
          NewExpression(node) {
            const [kind] = node.arguments;
            if (
              node.callee.type === "Identifier" &&
              (node.callee.name === "Event" ||
                node.callee.name === "CustomEvent") &&
              kind !== undefined && textOf(kind) === "unload"
            ) {
              context.report({ node, message: UNLOAD_MESSAGE });
            }
          },
          VariableDeclarator(node) {
            if (
              node.init?.type === "Identifier" && node.init.name === "Deno" &&
              node.id.type === "ObjectPattern" &&
              node.id.properties.some((property) =>
                property.type === "Property" &&
                property.key.type === "Identifier" &&
                property.key.name === "test"
              )
            ) {
              context.report({ node, message: DENO_TEST_MESSAGE });
            }
          },
          ImportExpression(node) {
            const text = textOf(node.source);
            if (text !== undefined && BDD.test(text)) {
              context.report({ node, message: BDD_MESSAGE });
            }
          },
          ImportDeclaration: (node) => fromBdd(node, node.source),
          ExportNamedDeclaration: (node) => fromBdd(node, node.source),
          ExportAllDeclaration: (node) => fromBdd(node, node.source),
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;

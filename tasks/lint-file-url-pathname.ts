/// <reference lib="deno.unstable" />

/**
 * A lint rule that stops code from turning a file URL into a path by reading
 * its `pathname`.
 *
 * The `pathname` of a URL is percent-encoded. For
 * `file:///Users/me/my%20work/labs/x.ts` it is `/Users/me/my%20work/labs/x.ts`,
 * which names no file once the checkout's path holds a space or a non-ASCII
 * character such as an emoji, and the read or the `deno run` handed that path
 * fails with `NotFound`. `fromFileUrl` from `@std/path` decodes the URL into
 * the path it names.
 *
 * The rule reports a read of `pathname`, by a member access or by destructuring
 * in a variable declaration, directly off a URL the same expression builds
 * from a file: `new URL(…)` or `URL.parse(…)` given `import.meta.url`, an
 * `import.meta.resolve(…)` call, or a literal starting with `file:`, and a
 * call to `toFileUrl`. It does not follow a URL through a variable or a
 * parameter. An assignment to `pathname`
 * is left alone, and so is a read whose value is assigned to another URL's
 * `pathname`, because both keep the path encoded.
 */

const MESSAGE =
  "The `pathname` of a file URL is percent-encoded, so it names no file once " +
  "the checkout's path holds a space or a non-ASCII character. Turn the URL " +
  "into a path with `fromFileUrl` from `@std/path`. See " +
  "docs/development/DEVELOPMENT.md, " +
  '"Turning a file URL into a path".';

type Node = Deno.lint.Node;

/** Returns true when `node` is `import.meta.<property>`. */
function isImportMeta(node: Node, property: string): boolean {
  return node.type === "MemberExpression" && !node.computed &&
    node.object.type === "MetaProperty" &&
    node.object.meta.name === "import" &&
    node.property.type === "Identifier" && node.property.name === property;
}

/** Returns true when `node` evidently holds a `file:` URL or its text. */
function namesFile(node: Node): boolean {
  if (isImportMeta(node, "url")) return true;
  if (node.type === "CallExpression") {
    return isImportMeta(node.callee, "resolve");
  }
  if (node.type === "Literal") {
    return typeof node.value === "string" && node.value.startsWith("file:");
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis[0].cooked.startsWith("file:");
  }
  return false;
}

/** Returns true when `node` evaluates to a `file:` URL object. */
function isFileUrl(node: Node): boolean {
  if (
    node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return isFileUrl(node.expression);
  }
  if (node.type === "NewExpression") {
    return isNamed(node.callee, "URL") && node.arguments.some(namesFile);
  }
  if (node.type === "CallExpression") {
    const callee = node.callee;
    if (
      callee.type === "MemberExpression" && isNamed(callee.object, "URL") &&
      isNamed(callee.property, "parse")
    ) {
      return node.arguments.some(namesFile);
    }
    return isNamed(
      callee.type === "MemberExpression" && !callee.computed
        ? callee.property
        : callee,
      "toFileUrl",
    );
  }
  return false;
}

/** Returns true when `node` is a `.pathname` member access. */
function isPathname(node: Node): boolean {
  return node.type === "MemberExpression" && !node.computed &&
    isNamed(node.property, "pathname");
}

/** Returns true when `node` is the identifier `name`. */
function isNamed(node: Node, name: string): boolean {
  return node.type === "Identifier" && node.name === name;
}

export default {
  name: "cf-path",
  rules: {
    "no-file-url-pathname": {
      create(context) {
        return {
          MemberExpression(node) {
            if (!isPathname(node)) return;
            // Writing a `pathname`, or copying one URL's onto another's,
            // keeps it encoded.
            const parent = node.parent;
            if (
              parent.type === "AssignmentExpression" &&
              (parent.left === node || isPathname(parent.left))
            ) {
              return;
            }
            if (isFileUrl(node.object)) {
              context.report({ node, message: MESSAGE });
            }
          },
          VariableDeclarator(node) {
            if (node.id.type !== "ObjectPattern" || node.init === null) return;
            if (!isFileUrl(node.init)) return;
            for (const property of node.id.properties) {
              if (
                property.type === "Property" && !property.computed &&
                isNamed(property.key, "pathname")
              ) {
                context.report({ node: property.key, message: MESSAGE });
              }
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;

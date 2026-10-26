import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import {
  buildCapturePropertyAssignments,
  buildHierarchicalParamsValue,
  type CaptureTreeNode,
  createCaptureAccessExpression,
  createCaptureTreeNode,
  groupCapturesByRoot,
  parseCaptureExpression,
} from "../../src/utils/capture-tree.ts";

const factory = ts.factory;

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

// Source-derived literal nodes read their text back from the source file they
// were parsed from, so nodes must be printed against that file (not a dummy).
const nodeSourceFiles = new WeakMap<ts.Node, ts.SourceFile>();

function print(node: ts.Node, file?: ts.SourceFile): string {
  const target = file ?? nodeSourceFiles.get(node) ?? printerScratchFile;
  return printer.printNode(ts.EmitHint.Unspecified, node, target);
}

function fileOf(node: ts.Node): ts.SourceFile {
  const file = nodeSourceFiles.get(node);
  assert(file);
  return file;
}

const printerScratchFile = ts.createSourceFile(
  "scratch.ts",
  "",
  ts.ScriptTarget.ESNext,
  true,
  ts.ScriptKind.TS,
);

/**
 * Parse `source` (an expression statement) and return its expression node,
 * with parent pointers set so that node predicates work.
 */
function parseExpression(source: string): ts.Expression {
  const file = ts.createSourceFile(
    "expr.ts",
    `(${source});`,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const statement = file.statements[0];
  assert(ts.isExpressionStatement(statement));
  // The wrapping parens produce a ParenthesizedExpression; unwrap one layer.
  const paren = statement.expression;
  assert(ts.isParenthesizedExpression(paren));
  const expr = paren.expression;
  nodeSourceFiles.set(expr, file);
  return expr;
}

Deno.test("parseCaptureExpression reads a bare identifier as an empty-path root", () => {
  const info = parseCaptureExpression(parseExpression("entry"));
  assert(info);
  assertEquals(info.root, "entry");
  assertEquals(info.path, []);
});

Deno.test("parseCaptureExpression flattens a key() call chain into path segments", () => {
  const info = parseCaptureExpression(
    parseExpression('entry.key("piece").key("title")'),
  );
  assert(info);
  assertEquals(info.root, "entry");
  assertEquals(info.path, ["piece", "title"]);
});

Deno.test("parseCaptureExpression rejects a key() call whose receiver is not a capture", () => {
  // The receiver `foo()` is a call, not an identifier/property access, so the
  // recursive parse returns undefined and the key() branch bails out.
  const info = parseCaptureExpression(parseExpression('foo().key("piece")'));
  assertEquals(info, undefined);
});

Deno.test("parseCaptureExpression rejects a key() call with a non-literal argument", () => {
  // A dynamic key argument cannot be reduced to a static path segment.
  const info = parseCaptureExpression(parseExpression("entry.key(dynamic)"));
  assertEquals(info, undefined);
});

Deno.test("parseCaptureExpression stops at an optional chain and captures the pre-chain identifier", () => {
  const info = parseCaptureExpression(parseExpression("entry?.name"));
  assert(info);
  assertEquals(info.root, "entry");
  assertEquals(info.path, []);
});

Deno.test("parseCaptureExpression rejects an optional chain rooted in a non-identifier, non-property expression", () => {
  // `foo()?.name` has a call expression before the `?.`, which is neither an
  // identifier nor a property access, so parsing fails.
  const info = parseCaptureExpression(parseExpression("foo()?.name"));
  assertEquals(info, undefined);
});

Deno.test("parseCaptureExpression collects a plain property-access chain into a path", () => {
  const info = parseCaptureExpression(parseExpression("entry.a.b.c"));
  assert(info);
  assertEquals(info.root, "entry");
  assertEquals(info.path, ["a", "b", "c"]);
});

Deno.test("groupCapturesByRoot skips expressions that do not parse as captures", () => {
  // A non-capture expression (element access on a call) is ignored; only the
  // parseable capture survives in the resulting tree.
  const skipped = parseExpression("foo()[0]");
  const kept = parseExpression("entry.name");
  const tree = groupCapturesByRoot([skipped, kept]);
  assertEquals([...tree.keys()], ["entry"]);
});

Deno.test("groupCapturesByRoot builds nested property nodes and collapses whole-root captures", () => {
  const tree = groupCapturesByRoot([
    parseExpression("entry.a.b"),
    parseExpression("other"),
  ]);
  const entry = tree.get("entry");
  assert(entry);
  // The nested path a.b becomes a chain of property nodes.
  const a = entry.properties.get("a");
  assert(a);
  const b = a.properties.get("b");
  assert(b);
  assert(b.expression);
  // A bare-root capture stores the expression at the root and clears children.
  const other = tree.get("other");
  assert(other);
  assert(other.expression);
  assertEquals(other.properties.size, 0);
});

Deno.test("createCaptureAccessExpression returns a key() template unchanged via the fast path", () => {
  const template = parseExpression('entry.key("piece")');
  const result = createCaptureAccessExpression(
    "__cf_entry",
    ["piece"],
    factory,
    template,
  );
  // The key() call template is returned verbatim, still rooted at `entry`.
  assertEquals(print(result, fileOf(template)), 'entry.key("piece")');
});

Deno.test("createCaptureAccessExpression rebuilds a property access rerooted at the new name", () => {
  const template = parseExpression("entry.name");
  const result = createCaptureAccessExpression(
    "__cf_entry",
    ["name"],
    factory,
    template,
  );
  assertEquals(print(result), "__cf_entry.name");
});

Deno.test("createCaptureAccessExpression preserves optional-chain property access when rebuilding", () => {
  const template = parseExpression("entry?.name");
  const result = createCaptureAccessExpression(
    "__cf_entry",
    ["name"],
    factory,
    template,
  );
  assertEquals(print(result), "__cf_entry?.name");
});

Deno.test("createCaptureAccessExpression rebuilds an element access rerooted at the new name", () => {
  const template = parseExpression('entry["name"]');
  const result = createCaptureAccessExpression(
    "__cf_entry",
    ["name"],
    factory,
    template,
  );
  assertEquals(print(result, fileOf(template)), '__cf_entry["name"]');
});

Deno.test("createCaptureAccessExpression preserves optional-chain element access when rebuilding", () => {
  const template = parseExpression('entry?.["name"]');
  const result = createCaptureAccessExpression(
    "__cf_entry",
    ["name"],
    factory,
    template,
  );
  assertEquals(print(result, fileOf(template)), '__cf_entry?.["name"]');
});

Deno.test("createCaptureAccessExpression falls back when an optional element-access chain cannot be rebuilt", () => {
  // `foo()?.["name"]` is an element access chain, but its inner expression is a
  // call that does not rebuild, so the whole rebuild fails and the function
  // synthesizes the access from rootName plus path segments instead.
  const template = parseExpression('foo()?.["name"]');
  const result = createCaptureAccessExpression(
    "__cf_entry",
    ["items"],
    factory,
    template,
  );
  assertEquals(print(result, fileOf(template)), "__cf_entry.items");
});

Deno.test("createCaptureAccessExpression falls back to path segments when the template cannot rebuild", () => {
  // A template that bottoms out on a call expression is not rebuildable, so the
  // function synthesizes the access from rootName plus the path segments.
  const template = parseExpression("foo().bar");
  const result = createCaptureAccessExpression(
    "__cf_entry",
    ["a", "b"],
    factory,
    template,
  );
  assertEquals(print(result), "__cf_entry.a.b");
});

Deno.test("createCaptureAccessExpression with no template builds access purely from path segments", () => {
  const result = createCaptureAccessExpression(
    "root",
    ["one", "two"],
    factory,
  );
  assertEquals(print(result), "root.one.two");
});

Deno.test("buildHierarchicalParamsValue emits a leaf access when a node holds only an expression", () => {
  const node: CaptureTreeNode = createCaptureTreeNode(["name"]);
  node.expression = parseExpression("entry.name");
  const result = buildHierarchicalParamsValue(node, "__cf_entry", factory);
  assertEquals(print(result), "__cf_entry.name");
});

Deno.test("buildHierarchicalParamsValue prefers the stored expression over empty property assignments", () => {
  // A node with an expression but no child properties takes the leaf path even
  // after the assignment loop runs, producing a single rerooted access.
  const node: CaptureTreeNode = createCaptureTreeNode(["value"]);
  node.expression = parseExpression("entry.value");
  const result = buildHierarchicalParamsValue(node, "root", factory);
  assertEquals(print(result), "root.value");
});

Deno.test("buildHierarchicalParamsValue emits an object literal for a node with child properties", () => {
  const tree = groupCapturesByRoot([
    parseExpression("entry.a"),
    parseExpression("entry.b"),
  ]);
  const entry = tree.get("entry");
  assert(entry);
  const result = buildHierarchicalParamsValue(entry, "__cf_entry", factory);
  const text = print(result);
  assert(text.startsWith("{"));
  assert(text.includes("a: __cf_entry.a"));
  assert(text.includes("b: __cf_entry.b"));
});

Deno.test("buildCapturePropertyAssignments applies renames to the root property name", () => {
  const tree = groupCapturesByRoot([parseExpression("entry.name")]);
  const assignments = buildCapturePropertyAssignments(
    tree,
    factory,
    new Map([["entry", "renamed"]]),
  );
  assertEquals(assignments.length, 1);
  // The rename map relabels the property; the value re-roots the capture at the
  // original root name, wrapped in an object literal for the single child.
  const childExpr = tree.get("entry")!.properties.get("name")!.expression!;
  const text = print(assignments[0], fileOf(childExpr));
  assert(text.startsWith("renamed:"));
  assert(text.includes("name: entry.name"));
});

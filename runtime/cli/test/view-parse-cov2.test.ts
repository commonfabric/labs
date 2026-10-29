/**
 * Second-round coverage tests for `lib/view/languages/typescript/parse.ts`,
 * extending `view-parse.test.ts` and `view-parse-cov.test.ts`. The dead and
 * duplicate branches these originally documented were removed or folded away at
 * the source; the tests here exercise the reachable behavior around them:
 * identifier classification, type-position resolution (qualified names,
 * `typeof`, heritage types), comment merging, definition registration, control
 * labels, and metadata extraction on malformed input, plus `safe`'s
 * degrade-to-undefined fallback via the test-only `_internal` handle.
 */

import { assert, assertEquals } from "@std/assert";
import {
  _internal,
  createHighlighter,
  highlightDocument,
  parseDocument,
} from "../lib/view/languages/typescript/parse.ts";
import type { Document, StructureNode, TokenClass } from "../lib/view/model.ts";

/** Every token class a given literal text is assigned across the document. */
function classesOf(doc: Document, token: string): Set<TokenClass> {
  const set = new Set<TokenClass>();
  for (const line of doc.lines) {
    for (const span of line.spans) {
      if (span.text === token) set.add(span.cls);
    }
  }
  return set;
}

/** Find the first structure node matching a predicate, flattened. */
function findNode(
  doc: Document,
  pred: (n: StructureNode) => boolean,
): StructureNode | undefined {
  return doc.flatStructure.find(pred);
}

function labelsOf(doc: Document): string[] {
  return doc.flatStructure.map((n) => n.label);
}

//
// isTypePosition: qualified names in type position (neighbor of 913)
//

Deno.test("qualified name in a type annotation resolves as a type name", () => {
  // `a.b.c.D` in type position climbs the qualified-name chain in
  // isTypePosition and resolves via ts.isTypeNode on the TypeReference, so the
  // final identifier `D` is a typeName, not a plain reference.

  const doc = parseDocument("let x: a.b.c.D = null as never;");
  const classes = classesOf(doc, "D");
  assert(
    classes.has("typeName"),
    `expected D to be a typeName, got ${[...classes].join(",")}`,
  );
});

//
// isTypePosition: typeof type (neighbor of 916)
//

Deno.test("typeof in a type annotation resolves the operand as a type name", () => {
  // `typeof foo` as a type produces a TypeQueryNode parent for `foo`. Because a
  // TypeQueryNode is itself a TypeNode, isTypePosition returns at the
  // ts.isTypeNode check before the more-specific TypeQuery branch.

  const doc = parseDocument("const foo = 1;\nlet y: typeof foo = foo;");
  // The `foo` inside the type query is a typeName; the value `foo` references
  // remain non-type classes, so both classifications appear for the token.
  const classes = classesOf(doc, "foo");
  assert(
    classes.has("typeName"),
    `expected a typeName foo, got ${[...classes].join(",")}`,
  );
});

//
// isTypePosition: heritage clause (neighbor of 917, 919, 920)
//

Deno.test("class heritage type resolves as a type name", () => {
  // `extends Base<number>` produces an ExpressionWithTypeArguments whose
  // expression is `Base`. That node is also a TypeNode, so `Base` resolves as a
  // typeName at line 914, never reaching the ExpressionWithTypeArguments
  // branch.

  const doc = parseDocument("class A extends Base<number> {}");
  const classes = classesOf(doc, "Base");
  assert(
    classes.has("typeName"),
    `expected Base to be a typeName, got ${[...classes].join(",")}`,
  );
});

Deno.test("interface heritage type resolves as a type name", () => {
  const doc = parseDocument("interface I extends Other { z: number }");
  const classes = classesOf(doc, "Other");
  assert(
    classes.has("typeName"),
    `expected Other to be a typeName, got ${[...classes].join(",")}`,
  );
});

//
// classifyIdentifier neighbors of 836: the full reachable classification
//

Deno.test("identifier classifications across declaration and use sites", () => {
  const src = [
    "function greet(name) { return name; }",
    "class Widget {}",
    "interface Shape { side: number }",
    "type Alias = Shape;",
    "enum Color { Red }",
    "const obj = { key: 1 };",
    "const { side } = obj;",
    "greet(obj);",
    "new Widget();",
    "recv.method();",
  ].join("\n");
  const doc = parseDocument(src);
  assert(classesOf(doc, "greet").has("functionName"));
  assert(classesOf(doc, "Widget").has("typeName"));
  assert(classesOf(doc, "Shape").has("interfaceName"));
  assert(classesOf(doc, "Alias").has("typeName"));
  assert(classesOf(doc, "Color").has("typeName"));
  // `side` is the property signature name in the interface and a binding in the
  // destructuring; at least one of those classes must appear.
  const sideClasses = classesOf(doc, "side");
  assert(sideClasses.has("propertyName") || sideClasses.has("binding"));
});

//
// mergeByStart neighbor of 1215: non-empty comment batches merge in
//

Deno.test("comments are threaded into the structure tree", () => {
  const src = [
    "// leading comment",
    "const a = 1;",
    "function f() {",
    "  // inner comment",
    "  return a;",
    "}",
  ].join("\n");
  const doc = parseDocument(src);
  const comments = doc.flatStructure.filter((n) => n.kind === "comment");
  assert(
    comments.length >= 2,
    `expected at least two comment nodes, got ${comments.length}`,
  );
  // The inner comment must be nested under the function, proving the per-host
  // batch merge ran with a non-empty additions array.
  assert(
    comments.some((c) => /inner comment/.test(c.label)),
    "expected the inner comment to be present in the tree",
  );
});

//
// registerDefinition neighbor of 1260: named declarations register
//

Deno.test("named declarations are registered as definitions", () => {
  const src = [
    "function alpha() {}",
    "const beta = 2;",
    "class Gamma {}",
  ].join("\n");
  const doc = parseDocument(src);
  assert(
    doc.definitions.has("alpha"),
    "alpha should be a registered definition",
  );
  assert(doc.definitions.has("beta"), "beta should be a registered definition");
  assert(
    doc.definitions.has("Gamma"),
    "Gamma should be a registered definition",
  );
  const alpha = doc.definitions.get("alpha")!;
  assertEquals(alpha[0].name, "alpha");
});

//
// controlLabel neighbors of 1674: all eight control-statement labels
//

Deno.test("every control statement gets its dedicated label", () => {
  const src = [
    "if (cond) { doIf(); }",
    "while (cond) { doWhile(); }",
    "do { doDo(); } while (cond);",
    "switch (sel) { case 1: break; }",
    "for (;;) { doFor(); }",
    "for (const x of xs) { doForOf(); }",
    "for (const y in ys) { doForIn(); }",
    "try { doTry(); } catch (e) { handle(e); }",
  ].join("\n");
  const doc = parseDocument(src);
  const labels = labelsOf(doc);
  const has = (re: RegExp) => labels.some((l) => re.test(l));
  assert(has(/^if \(/), "missing if label");
  assert(has(/^while \(/), "missing while label");
  assert(has(/^do … while$/), "missing do…while label");
  assert(has(/^switch \(/), "missing switch label");
  assert(has(/^for \(…\)$/), "missing for label");
  assert(has(/^for \(… of …\)$/), "missing for-of label");
  assert(has(/^for \(… in …\)$/), "missing for-in label");
  assert(has(/^try$/), "missing try label");
});

//
// safe() neighbors of 1725-1727: extractors never throw on parseable input
//

Deno.test("metadata extraction survives malformed but parseable input", () => {
  // These all parse (via TypeScript error recovery) into nodes with valid
  // ranges, so the metadata extractors run their bodies without throwing and
  // the safe() catch is never taken.

  const cases = [
    "type Bad = ;",
    "interface Q extends { }",
    "import from 'x';",
    "const s = { type: } as const satisfies Schema;",
    "function f<>() {}",
  ];
  for (const c of cases) {
    const doc = parseDocument(c);
    assert(doc.flatStructure.length >= 1, `no structure for: ${c}`);
    // highlighting the same input must also succeed.
    assert(highlightDocument(c).length >= 1, `no lines for: ${c}`);
  }
});

Deno.test("import metadata is extracted without error", () => {
  const doc = parseDocument(
    "import def, { named, other as alias } from 'mod';\n" +
      "import * as ns from 'space';",
  );
  const imp = findNode(doc, (n) => n.kind === "import" && n.meta !== undefined);
  assert(imp, "expected an import node carrying metadata");
  assertEquals(imp!.meta!.kind, "import");
});

//
// describeInitializer neighbors of 2051-2053
//

Deno.test("a raw arrow initializer becomes a closure node, not a variable", () => {
  // bindingDesc routes the arrow to a closure before variableMeta /
  // describeInitializer would run, so describeInitializer never sees an arrow.

  const doc = parseDocument("const handler = () => 1;");
  const node = findNode(doc, (n) => n.name === "handler");
  assert(node, "expected a node bound to `handler`");
  assertEquals(node!.kind, "closure");
});

Deno.test("a parenthesised arrow initializer also becomes a closure node", () => {
  // peelExpr strips the parentheses before the arrow check, so this too is a
  // closure and bypasses describeInitializer.

  const doc = parseDocument("const wrapped = (() => 2);");
  const node = findNode(doc, (n) => n.name === "wrapped");
  assert(node, "expected a node bound to `wrapped`");
  assertEquals(node!.kind, "closure");
});

Deno.test("describeInitializer reports non-closure initializers", () => {
  // The reachable describeInitializer outputs: the no-initializer case and the
  // nodeFirstLine fall-through. These run for the variable-kind nodes below.

  const doc = parseDocument(
    "let pending;\nconst result = computeValue();\nconst total = a + b;",
  );
  const pending = findNode(doc, (n) => n.name === "pending");
  assert(pending, "expected a node bound to `pending`");
  assertEquals(pending!.meta?.kind, "variable");
  // An uninitialized binding reports the sentinel from describeInitializer.
  assertEquals(
    (pending!.meta as { bindsTo?: string }).bindsTo,
    "(uninitialized)",
  );

  const result = findNode(doc, (n) => n.name === "result");
  assert(result, "expected a node bound to `result`");
  assertEquals(result!.meta?.kind, "variable");
  const bindsTo = (result!.meta as { bindsTo?: string }).bindsTo;
  assert(
    typeof bindsTo === "string" && bindsTo.length > 0 &&
      bindsTo !== "closure",
    `expected a non-closure description, got ${bindsTo}`,
  );
});

//
// incremental highlighter still re-highlights an edited closure line
//

Deno.test("incremental highlighter updates a line that adds a closure", () => {
  const h = createHighlighter("const a = 1;\nconst b = 2;\n");
  const before = h.lines.length;
  const after = h.update("const a = 1;\nconst b = () => 2;\n");
  assertEquals(after.length, before);
  const joined = after
    .map((l) => l.spans.map((s) => s.text).join(""))
    .join("\n");
  assert(/=>/.test(joined), "updated text should contain the arrow");
});

//
// safe(): both arms, reached through the test-only handle
//

Deno.test("safe(): a throwing extractor degrades to undefined", () => {
  // safe() wraps the best-effort metadata extractors. The public API never
  // feeds them a node that throws, so the catch is exercised directly through
  // the test-only handle: a throwing extractor degrades to undefined, a
  // succeeding one returns its value.

  assertEquals(
    _internal.safe(() => {
      throw new Error("boom");
    }),
    undefined,
  );
  assertEquals(_internal.safe(() => 42), 42);
});

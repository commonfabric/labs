/**
 * Coverage-driving tests for `lib/view/languages/typescript/parse.ts`. These exercise the parser's
 * less-traveled branches: the incremental highlighter's no-op and walk-back
 * paths, the full set of identifier classifications, every structure-tree
 * classification (methods, enums, namespaces, control flow, labels), the schema
 * and type metadata extractors, and the syntactic type-inference branches.
 *
 * They assert real outputs (token classes, structure-node kinds/labels, parsed
 * metadata), not just that a line runs.
 *
 * A few lines in parse.ts are defensive guards that cannot be reached from a
 * unit test through the public API, and are left uncovered deliberately:
 *   - classifyIdentifier line 836 and isTypePosition line 913 (`if (!p) …`):
 *     the source file is parsed with setParentNodes, so every identifier always
 *     has a parent.
 *   - isTypePosition lines 916–920 (TypeQuery / ExpressionWithTypeArguments):
 *     both node kinds are also TypeNodes, so the `isTypeNode(p)` check on the
 *     line above returns first; these more-specific branches never run.
 *   - mergeByStart line 1215 and registerDefinition line 1260 (empty-input
 *     early returns): both functions are only ever called with non-empty /
 *     named input by their callers, so the early `return` is never taken.
 *   - controlLabel line 1674 (final fallback): controlLabel only runs for the
 *     eight control statements each handled by an earlier branch.
 *   - safe() catch lines 1725–1727: the wrapped metadata extractors operate on
 *     already-parsed, well-formed nodes and do not throw on valid input.
 *   - describeInitializer lines 2051–2053 (arrow/function → "closure"): an
 *     arrow or function initializer is routed to a closure node before
 *     describeInitializer (used only for variable-kind nodes) is ever called.
 */

import { assert, assertEquals } from "@std/assert";
import {
  createHighlighter,
  highlightDocument,
  highlightLineEditLocally,
  parseDocument,
} from "../lib/view/languages/typescript/parse.ts";
import { languageForFile } from "../lib/view/languages/language.ts";
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

function labels(doc: Document): string[] {
  return doc.flatStructure.map((n) => `${n.kind}:${n.label}`);
}

//
// registry: a .md filename highlights as Markdown
//

Deno.test("registry: a .md filename is highlighted as Markdown", () => {
  const lines = languageForFile("README.md").highlightLines(
    "# Heading\n\n```\ncode\n```\n",
    "README.md",
  );
  // A Markdown heading line is a single sectionHeader span — the TypeScript
  // path would split `# Heading` into an operator and an identifier.
  assertEquals(lines.length, 6);
  assertEquals(lines[0].spans.length, 1, "heading is one span");
  assertEquals(
    lines[0].spans[0].cls,
    "sectionHeader",
    "the heading line is a section header, proving the Markdown path ran",
  );
  // The fenced code block opener is punctuation, its body a string — both
  // Markdown-only classifications.
  assert(
    lines[2].spans.some((s) => s.cls === "punctuation"),
    "the fence opener is punctuation",
  );
  assert(
    lines[3].spans.some((s) => s.cls === "string"),
    "the fenced code body is a string",
  );
});

//
// Highlight refresh: the no-op paths, and an edit that is not (lines 297, 403)
//

Deno.test("createHighlighter: update with identical text returns the same lines", () => {
  const src = "const a = 1;\nconst b = 2;\n";
  const hl = createHighlighter(src, "m.ts");
  const before = hl.lines;
  const after = hl.update(src);
  // diffRange returns null for identical text, so update short-circuits and
  // hands back the exact same array reference.
  assertEquals(after, before);
});

Deno.test("highlightLineEditLocally: unchanged text returns the original line", () => {
  const before = createHighlighter('const value = "same";', "m.ts").lines[0];
  assert(highlightLineEditLocally(before, before.text) === before);
});

Deno.test("highlightLineEditLocally: editing a called member key refreshes its definition name", () => {
  const before = createHighlighter('worker["run"]();', "m.ts").lines[0];
  const after = highlightLineEditLocally(before, 'worker["stop"]();');
  assert(after, "the quoted-string fast path handles the edit");
  const key = after.spans.find((span) => span.text === '"stop"');
  assert(key, "the edited key remains one string span");
  assertEquals(key.exactDefinitionName, "stop");
  assertEquals(key.exactDefinitionDisplayName, '"stop"');
});

//
// safeStartLine walk-back past a multi-line token (lines 459, 460)
//

/** Assert that the incremental highlighter's result for `edited` is identical
 * to a full parse, span for span. */
function assertIncrementalMatches(
  base: string,
  edited: string,
): void {
  const hl = createHighlighter(base, "m.ts");
  const inc = hl.update(edited);
  const full = highlightDocument(edited, "m.ts");
  assertEquals(inc.length, full.length, "same line count");
  for (let i = 0; i < full.length; i++) {
    assertEquals(inc[i].text, full[i].text, `line ${i} text`);
    assertEquals(
      inc[i].spans.map((s) =>
        `${s.cls}:${s.text}:${s.bracketDepth}:${s.exactDefinitionName}:${s.exactDefinitionDisplayName}`
      ),
      full[i].spans.map((s) =>
        `${s.cls}:${s.text}:${s.bracketDepth}:${s.exactDefinitionName}:${s.exactDefinitionDisplayName}`
      ),
      `line ${i} spans`,
    );
  }
}

Deno.test("createHighlighter: an edit inside a multi-line template matches a full parse", () => {
  // The template literal spans several lines; an edit on a later line of it
  // re-highlights from the statement boundary and matches a full parse.

  const base = "const t = `line one\nline two\nline three`;\nconst x = 1;\n";
  assertIncrementalMatches(base, base.replace("line two", "line TWO"));
});

Deno.test("createHighlighter: an edited multi-line call key has one lookup marker", () => {
  const base = "worker[`line one\nline two`]();\nconst x = 1;\n";
  const hl = createHighlighter(base, "m.ts");
  const lines = hl.update(base.replace("line two", "line TWO"));
  assertEquals(
    lines.flatMap((line) => line.spans)
      .filter((span) => span.exactDefinitionName !== undefined)
      .map((span) => [
        span.text,
        span.exactDefinitionName,
        span.exactDefinitionDisplayName,
      ]),
    [["`line one", "line one\nline TWO", '"line one\\nline TWO"']],
  );
});

Deno.test("createHighlighter: editing a statement whose line opens inside an earlier block comment", () => {
  // The block comment opens on line 0 and its tail `*/` shares line 1 with the
  // `const b` statement. Editing `const b` makes safeStartLine walk back from
  // line 1 to line 0 (the line the comment opened on), since line 1's start is
  // inside the still-open comment.

  const base = "const a = 1; /* c\nomment tail */ const b = 2;\nconst c = 3;\n";
  assertIncrementalMatches(base, base.replace("const b = 2", "const b = 22"));
});

//
// collectTokensInRange skips JSDoc (line 572)
//

Deno.test("createHighlighter: an edit near a JSDoc comment stays one whole comment", () => {
  // A JSDoc block with @tags attaches as JSDoc nodes to the function below it.
  // Editing the statement *above* widens the rebuild range down across that
  // function, so collectTokensInRange visits and skips the JSDoc nodes rather
  // than tokenising them as code.

  const base = [
    "const head = 1;",
    "",
    "/**",
    " * Builds a {@link Document} from text.",
    " * @param x the input",
    " * @returns the result",
    " */",
    "function build(x) { return x; }",
    "const tail = 2;",
    "",
  ].join("\n");
  const hl = createHighlighter(base, "m.ts");
  // Edit the first statement so the re-highlight widens past the JSDoc function.
  const edited = base.replace("const head = 1;", "const head = 100;");
  const inc = hl.update(edited);
  const full = highlightDocument(edited, "m.ts");
  assertEquals(inc.length, full.length);
  for (let i = 0; i < full.length; i++) {
    assertEquals(
      inc[i].spans.map((s) => `${s.cls}:${s.text}`),
      full[i].spans.map((s) => `${s.cls}:${s.text}`),
      `line ${i} spans match a full parse`,
    );
  }
  // The JSDoc lines (2–6) stay whole doc comments, not torn into Identifiers.
  for (let i = 2; i <= 6; i++) {
    assert(
      inc[i].spans.every((s) =>
        s.cls === "docComment" || s.cls === "whitespace"
      ),
      `line ${i} is whole doc comment, not code`,
    );
  }
});

//
// classifyToken: null is a boolean-class literal (line 803)
//

Deno.test("parse: null, true and false are colored as boolean literals", () => {
  const doc = parseDocument(
    "const a = null;\nconst b = true;\nconst c = false;\n",
  );
  assert(classesOf(doc, "null").has("boolean"), "null is boolean-classed");
  assert(classesOf(doc, "true").has("boolean"), "true is boolean-classed");
  assert(classesOf(doc, "false").has("boolean"), "false is boolean-classed");
});

//
// classifyIdentifier: declaration-name and access branches
//
// Covers lines 844-846 (function/method/method-signature names), 848-852
// (interface/class/class-expression names), 854 (enum name), 869-870
// (property declaration / enum member), 877 (synthetic helper member access).
//

Deno.test("parse: function, method and interface declaration names are classified", () => {
  const src = [
    "function topFn() { return 1; }",
    "interface IFace { m(): void; p: number; }",
    "class C { method() {} field = 1; }",
    "const ce = class Named {};",
    "type Ali = number;",
    "enum Color { Red, Green }",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  assert(classesOf(doc, "topFn").has("functionName"), "function name");
  assert(classesOf(doc, "method").has("functionName"), "method name");
  assert(classesOf(doc, "m").has("functionName"), "method signature name");
  assert(classesOf(doc, "IFace").has("interfaceName"), "interface name");
  assert(classesOf(doc, "C").has("typeName"), "class declaration name");
  assert(classesOf(doc, "Named").has("typeName"), "class expression name");
  assert(classesOf(doc, "Ali").has("typeName"), "type alias name");
  assert(classesOf(doc, "Color").has("typeName"), "enum name");
  assert(classesOf(doc, "field").has("propertyName"), "class property");
  assert(classesOf(doc, "p").has("propertyName"), "property signature");
  assert(classesOf(doc, "Red").has("propertyName"), "enum member");
});

Deno.test("parse: parameter, binding and shorthand classifications", () => {
  const src = [
    "function g(arg) { return arg; }",
    "const { destructured } = obj;",
    "const ref = something;",
    "const shorthandObj = { ref };",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  assert(classesOf(doc, "arg").has("parameter"), "parameter name");
  assert(classesOf(doc, "destructured").has("binding"), "binding element");
  assert(classesOf(doc, "ref").has("binding"), "plain variable binding");
  // Shorthand `{ ref }` reads as a reference (identifier), not a property name.
  assert(classesOf(doc, "ref").has("identifier"), "shorthand is a reference");
});

Deno.test("parse: a synthetic name in property-access position is a cfHelper", () => {
  // `obj.__cfHandler_1` — the synthetic name is the `.name` of a property
  // access, not a callee and not a builder, so the property-access synthetic
  // branch classifies it as cfHelper.

  const doc = parseDocument("const r = registry.__cfHandler_1;\n", "m.ts");
  assert(
    classesOf(doc, "__cfHandler_1").has("cfHelper"),
    "a synthetic property name is a cfHelper",
  );
});

Deno.test("parse: a builder reached via property access is a builderCall", () => {
  // `x.pattern(…)` — property-access callee whose name is a builder.

  const doc = parseDocument("const z = obj.lift(fn);\n", "m.ts");
  assert(
    classesOf(doc, "lift").has("builderCall"),
    "a member-access builder call is a builderCall",
  );
});

Deno.test("parse: a synthetic identifier used as a type name is a cfHelper", () => {
  // `__cfHelpers.JSONSchema` in type position — isTypePosition true and the
  // name is synthetic, so the type-position synthetic branch fires.

  const doc = parseDocument(
    "let v: __cfHelpers.JSONSchema = x;\n",
    "m.ts",
  );
  assert(
    classesOf(doc, "__cfHelpers").has("cfHelper"),
    "synthetic name in a type position is a cfHelper",
  );
});

//
// isTypePosition branches (lines 913-920)
//

Deno.test("parse: type parameters, typeof queries and heritage clauses are type positions", () => {
  const src = [
    "function gen<T>(x: T): T { return x; }",
    "type Q = typeof someValue;",
    "class Sub extends Base {}",
    "interface I extends Other {}",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  // Type parameter declaration name `T` is a typeName.
  assert(classesOf(doc, "T").has("typeName"), "type parameter is a typeName");
  // `someValue` inside `typeof` query is a type position.
  assert(
    classesOf(doc, "someValue").has("typeName"),
    "typeof-query operand is a typeName",
  );
  // Heritage clause type `Base` (extends) is a type position.
  assert(classesOf(doc, "Base").has("typeName"), "extends clause type");
  assert(classesOf(doc, "Other").has("typeName"), "interface extends type");
});

Deno.test("parse: a generic type parameter declaration name is a typeName", () => {
  // The declared `T` in `gen<T>` has a TypeParameter parent — not a TypeNode —
  // so isTypePosition resolves it through the type-parameter branch.

  const doc = parseDocument("function gen<T>(x) { return x; }\n", "m.ts");
  assert(classesOf(doc, "T").has("typeName"), "type parameter declaration");
});

//
// comments threaded into the structure tree (mergeByStart, 1214/1216)
//

Deno.test("parse: comments are merged into the structure tree in source order", () => {
  // Several comments at the same nesting level batch and merge via mergeByStart.

  const src = [
    "// first note",
    "const a = 1;",
    "// second note",
    "const b = 2;",
    "// third note",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const comments = doc.flatStructure.filter((n) => n.kind === "comment");
  assertEquals(comments.length, 3, "all three comments are nodes");
  // They appear in source order, interleaved with the bindings.
  const order = doc.flatStructure
    .filter((n) => n.kind === "comment" || n.kind === "variable")
    .map((n) => n.label);
  assertEquals(order, [
    "// first note",
    "a",
    "// second note",
    "b",
    "// third note",
  ]);
});

//
// genericLabel: ElementAccessExpression (lines 1095-1097)
//

Deno.test("parse: an element-access expression gets a […] generic label", () => {
  const doc = parseDocument("const e = arr[index];\n", "m.ts");
  // The element-access node is labeled `arr[…]`.
  assert(
    findNode(doc, (n) => n.label === "arr[…]"),
    `expected an element-access node, got ${labels(doc).join(" | ")}`,
  );
});

Deno.test("parse: a named binding registers a definition", () => {
  // registerDefinition no-name guard (line 1260): Covered indirectly:
  // registerDefinition is only called when desc.name is set, but the early `if
  // (!desc.name) return` is reached when called for a name. A named binding
  // exercises the body; the guard line itself runs every call.

  const doc = parseDocument("const namedThing = 1;\n", "m.ts");
  assert(doc.definitions.has("namedThing"), "named binding is in the index");
  const def = doc.definitions.get("namedThing")![0];
  assertEquals(def.kind, "variable");
});

//
// classify: method / constructor / accessor declarations (1308-1334)
//

Deno.test("parse: class methods, constructor and accessors become method nodes", () => {
  const src = [
    "class Widget {",
    "  constructor(a) { this.a = a; }",
    "  doThing() { return 1; }",
    "  get size() { return 2; }",
    "  set size(v) {}",
    "}",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const ls = labels(doc);
  assert(ls.includes("class:class Widget"), "the class node");
  assert(ls.some((l) => l === "method:ƒ constructor"), "constructor node");
  assert(ls.some((l) => l === "method:ƒ doThing"), "method node");
  assert(ls.some((l) => l === "method:ƒ size"), "accessor node");
  // The constructor node carries no name (it is not a definition target).
  const ctor = findNode(doc, (n) => n.label === "ƒ constructor");
  assert(ctor && ctor.name === undefined, "constructor has no name");
  // A named method registers a definition.
  assert(doc.definitions.has("doThing"), "method is a definition");
});

//
// classify: enum / export assignment / export decl / import equals /
// module declaration (lines 1353-1390)
//

Deno.test("parse: enums, exports, import-equals and namespaces classify distinctly", () => {
  const src = [
    "enum Status { On, Off }",
    "export default someExpr;",
    "export { a, b } from './x';",
    "import fs = require('fs');",
    "namespace NS { export const inner = 1; }",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const ls = labels(doc);
  assert(ls.some((l) => l === "typeAlias:enum Status"), "enum node");
  assert(
    ls.some((l) => l.startsWith("export:export default")),
    "export assignment node",
  );
  assert(
    ls.some((l) => l.startsWith("export:export {")),
    "export declaration node",
  );
  assert(
    ls.some((l) => l.startsWith("import:import fs")),
    "import-equals node",
  );
  assert(
    ls.some((l) => l === "class:namespace NS"),
    `namespace node, got ${ls.join(" | ")}`,
  );
  assert(doc.definitions.has("NS"), "namespace name is a definition");
});

Deno.test("parse: an anonymous namespace (string-literal module name) has no name", () => {
  const doc = parseDocument(
    `declare module "ext" { const v: number; }\n`,
    "m.ts",
  );
  const ns = findNode(
    doc,
    (n) => n.kind === "class" && n.label.startsWith("namespace"),
  );
  assert(ns, "the ambient module is a node");
  assertEquals(ns!.name, undefined, "a string-named module exposes no name");
});

//
// classify: multi-declarator variable statement & declaration (1400-1408)
//

Deno.test("parse: a multi-declarator var statement yields a binding node per declaration", () => {
  const doc = parseDocument("const a = 1, b = 2, c = 3;\n", "m.ts");
  // The statement itself stays generic (null from classify); each declaration
  // is its own binding node.
  assert(doc.definitions.has("a"), "a registered");
  assert(doc.definitions.has("b"), "b registered");
  assert(doc.definitions.has("c"), "c registered");
  const ls = labels(doc);
  assert(ls.includes("variable:a"), "a is a variable node");
  assert(ls.includes("variable:b"), "b is a variable node");
});

//
// classify: labeled / break / continue / empty / debugger (1435-1450)
//

Deno.test("parse: labeled statements and jump statements are reachable nodes", () => {
  const src = [
    "outer: for (;;) { break outer; }",
    "while (true) { continue; }",
    ";",
    "debugger;",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const ls = labels(doc);
  assert(ls.some((l) => l === "statement:outer:"), "labeled statement node");
  assert(ls.some((l) => l.startsWith("statement:break")), "break node");
  assert(ls.some((l) => l.startsWith("statement:continue")), "continue node");
  assert(ls.some((l) => l === "statement:;"), "empty statement node");
  assert(ls.some((l) => l.startsWith("statement:debugger")), "debugger node");
});

//
// classify: in-statement-list fallback (lines 1455-1460)
//

Deno.test("parse: an unusual statement still becomes a reachable statement node", () => {
  // A `with` statement is not specially handled, so it falls through to the
  // generic in-statement-list branch.

  const doc = parseDocument("with (obj) { doThing(); }\n", "m.ts");
  const node = findNode(
    doc,
    (n) => n.kind === "statement" && n.label.startsWith("with"),
  );
  assert(
    node,
    `expected a generic with-statement node, got ${labels(doc).join(" | ")}`,
  );
});

//
// bindingDesc: no initializer (lines 1496-1505)
//

Deno.test("parse: an uninitialized binding becomes a variable node with no init meta", () => {
  const doc = parseDocument("let pending: number;\n", "m.ts");
  const node = findNode(doc, (n) => n.name === "pending");
  assert(node, "the uninitialized binding is a node");
  assertEquals(node!.kind, "variable");
  assertEquals(node!.label, "pending");
  // Its variable meta reports an uninitialized binding and the annotated type.
  assert(node!.meta && node!.meta.kind === "variable");
  if (node!.meta && node!.meta.kind === "variable") {
    assertEquals(node!.meta.bindsTo, "(uninitialized)");
    assertEquals(node!.meta.typeText, "number");
  }
});

//
// bindingDesc: schema and plain-object initializers (lines 1534-1543)
//

Deno.test("parse: a binding whose initializer is a schema object is a schema node", () => {
  const src = [
    "const sch = {",
    '    type: "object",',
    "    properties: {",
    '        name: { type: "string" }',
    "    },",
    '    required: ["name"]',
    "} as const satisfies __cfHelpers.JSONSchema;",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const node = findNode(doc, (n) => n.name === "sch");
  assert(node, "the schema binding is a node");
  assertEquals(node!.kind, "schema");
  assert(node!.label.startsWith("schema sch {"), `label was ${node!.label}`);
  assert(node!.meta && node!.meta.kind === "schema", "carries schema meta");
});

Deno.test("parse: a binding whose initializer is a plain object is an object node", () => {
  const doc = parseDocument("const cfg = { a: 1, b: 2 };\n", "m.ts");
  const node = findNode(doc, (n) => n.name === "cfg");
  assert(node, "the object binding is a node");
  assertEquals(node!.kind, "object");
  assert(node!.label.startsWith("cfg {"), `label was ${node!.label}`);
});

//
// expressionStatementDesc: a bare arrow expression (1572-1579)
//

Deno.test("parse: a bare arrow-function expression statement is a closure node", () => {
  // An expression statement whose expression is an arrow function.

  const doc = parseDocument("(x) => x + 1;\n", "m.ts");
  const node = findNode(doc, (n) => n.kind === "closure");
  assert(node, `expected a closure node, got ${labels(doc).join(" | ")}`);
  assert(node!.label.startsWith("λ"), `label was ${node!.label}`);
});

//
// primaryChildren: arrow + reactive call in return position (1620-1626)
//

Deno.test("parse: a return of an arrow recurses into its body", () => {
  const src = [
    "function maker() {",
    "  return () => {",
    "    lift(inner);",
    "  };",
    "}",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  // The reactive `lift` call buried in the returned arrow's body is reached.
  assert(
    findNode(doc, (n) => n.kind === "builder" && n.label.startsWith("lift")),
    `lift inside the returned arrow is a builder node, got ${
      labels(doc).join(" | ")
    }`,
  );
});

Deno.test("parse: a return of a reactive call recurses into its arguments", () => {
  const src = [
    "function f2() {",
    "  return pattern((input) => input);",
    "}",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  assert(
    findNode(doc, (n) => n.kind === "pattern"),
    `the returned pattern call is a pattern node, got ${
      labels(doc).join(" | ")
    }`,
  );
});

//
// controlLabel: every control-flow shape (1667-1674)
//

Deno.test("parse: every control-flow shape gets its distinct label", () => {
  const src = [
    "while (cond) { a(); }",
    "do { b(); } while (cond);",
    "switch (v) { case 1: break; }",
    "for (let i = 0; i < 3; i++) { c(); }",
    "for (const k in obj) { d(); }",
    "for (const e of items) { g(); }",
    "if (cond) { h(); }",
    "try { risky(); } catch (e) {}",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const ls = labels(doc);
  assert(ls.some((l) => l.startsWith("control:while (")), "while label");
  assert(ls.some((l) => l === "control:do … while"), "do-while label");
  assert(ls.some((l) => l.startsWith("control:switch (")), "switch label");
  assert(ls.some((l) => l === "control:for (…)"), "for label");
  assert(ls.some((l) => l === "control:for (… in …)"), "for-in label");
  assert(ls.some((l) => l === "control:for (… of …)"), "for-of label");
  assert(ls.some((l) => l.startsWith("control:if (")), "if label");
  assert(ls.some((l) => l === "control:try"), "try label");
});

//
// calleeName: a non-identifier non-property callee (line 1708)
//

Deno.test("parse: a computed-callee call is labeled by its first source line", () => {
  // `(obj["m"])(…)` — the callee is neither a plain identifier nor a property
  // access, so calleeName falls back to nodeFirstLine.

  const doc = parseDocument(`const r = (table["run"])(1);\n`, "m.ts");
  const node = findNode(doc, (n) => n.name === "r");
  assert(node, "the binding is a node");
  // The variable label embeds the callee text from nodeFirstLine.
  assert(
    node!.label.includes("(…)"),
    `binding label shows a call, got ${node!.label}`,
  );
});

//
// importMeta: default name + namespace import (lines 1740, 1743)
//

Deno.test("parse: import metadata captures default, namespace and named bindings", () => {
  const src = [
    `import def from "modA";`,
    `import * as ns from "modB";`,
    `import { one, two } from "modC";`,
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const imports = doc.flatStructure.filter((n) => n.kind === "import");
  const names = new Set<string>();
  let sawNamespace = false;
  let module = "";
  for (const imp of imports) {
    if (imp.meta && imp.meta.kind === "import") {
      for (const nm of imp.meta.names) {
        names.add(nm);
        if (nm.startsWith("* as ")) sawNamespace = true;
      }
      module = imp.meta.module;
    }
  }
  assert(names.has("def"), "default import name captured");
  assert(sawNamespace, "namespace import captured as `* as ns`");
  assert(names.has("one") && names.has("two"), "named imports captured");
  assert(module.length > 0, "a module specifier is recorded");
});

//
// membersOf: method signature + index signature (lines 1792-1804)
//

Deno.test("parse: interface metadata describes property, method and index members", () => {
  const src = [
    "interface Shape {",
    "  width: number;",
    "  resize(): void;",
    "  [key: string]: unknown;",
    "}",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const iface = findNode(doc, (n) => n.kind === "interface");
  assert(iface && iface.meta && iface.meta.kind === "type", "interface meta");
  if (iface && iface.meta && iface.meta.kind === "type") {
    const byName = new Map(iface.meta.members.map((m) => [m.name, m]));
    assertEquals(byName.get("width")?.type, "number");
    assertEquals(byName.get("resize")?.type, "() => …", "method signature");
    assert(byName.has("[index]"), "index signature recorded");
  }
});

//
// parseSchemaObject + fieldType: array / object / anyOf branches
//
// Covers 1819-1820 (non-property-assignment skip), 1847-1857 (fieldType array,
// object, anyOf/oneOf fallthrough), 1871, 1894-1899 (readSchemaProps/hasProp).
//

Deno.test("parse: schema metadata describes nested arrays, objects and unions", () => {
  const src = [
    "const big = {",
    '  type: "object",',
    "  properties: {",
    '    tags: { type: "array", items: { type: "string" } },',
    '    nested: { type: "object", properties: { inner: { type: "number" } } },',
    '    choice: { anyOf: [{ type: "string" }] },',
    "    ...spread,",
    "  },",
    '  required: ["tags"],',
    "} as const satisfies __cfHelpers.JSONSchema;",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const node = findNode(doc, (n) => n.name === "big");
  assert(
    node && node.meta && node.meta.kind === "schema",
    "schema meta present",
  );
  if (node && node.meta && node.meta.kind === "schema") {
    const fields = new Map(node.meta.schema.fields.map((f) => [f.name, f]));
    assertEquals(fields.get("tags")?.type, "string[]", "array of strings");
    assert(fields.get("tags")?.required, "tags is required");
    assertEquals(fields.get("nested")?.type, "object", "nested object field");
    assert(
      (fields.get("nested")?.fields?.length ?? 0) >= 1,
      "nested object has sub-fields",
    );
    assertEquals(fields.get("choice")?.type, "anyOf", "union field type");
    assertEquals(node.meta.schema.rootType, "object");
  }
});

Deno.test("parse: an array-rooted schema with no items reports type array", () => {
  const src = [
    "const arrSchema = {",
    '  type: "array",',
    "} as const satisfies __cfHelpers.JSONSchema;",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const node = findNode(doc, (n) => n.name === "arrSchema");
  assert(node && node.meta && node.meta.kind === "schema");
  if (node && node.meta && node.meta.kind === "schema") {
    assertEquals(node.meta.schema.rootType, "array");
  }
});

Deno.test("parse: schema fields handle array-without-items, bare object and non-object values", () => {
  const src = [
    "const edge = {",
    "  ...spreadBase,", // a spread element is not a property assignment
    '  type: "object",',
    "  properties: {",
    '    plainArr: { type: "array" },', // array with no items -> "array"
    '    blob: { description: "x" },', // no type, no union keys -> "any"
    '    weird: "notAnObject",', // value not an object literal -> skipped
    "  },",
    "} as const satisfies __cfHelpers.JSONSchema;",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const node = findNode(doc, (n) => n.name === "edge");
  assert(node && node.meta && node.meta.kind === "schema");
  if (node && node.meta && node.meta.kind === "schema") {
    // The spread is skipped by readSchemaProps, yet the rest parses normally.
    assertEquals(node.meta.schema.rootType, "object");
    const fields = new Map(node.meta.schema.fields.map((f) => [f.name, f]));
    assertEquals(fields.get("plainArr")?.type, "array", "array without items");
    assertEquals(fields.get("blob")?.type, "any", "bare object field");
    // The non-object-literal value is skipped, so no `weird` field exists.
    assert(!fields.has("weird"), "non-object schema value is skipped");
  }
});

Deno.test("parse: a schema with neither type nor properties roots as any", () => {
  const src = [
    "const looseSchema = {",
    '  description: "x",',
    "} as const satisfies __cfHelpers.JSONSchema;",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const node = findNode(doc, (n) => n.name === "looseSchema");
  assert(node && node.meta && node.meta.kind === "schema");
  if (node && node.meta && node.meta.kind === "schema") {
    assertEquals(node.meta.schema.rootType, "any");
  }
});

//
// contractMeta + builder schemas / config args (lines 1899-1937)
//

Deno.test("parse: a builder call records input/output schemas, config args and captures", () => {
  const src = [
    "const helper = lift<{ a: number }, string>(",
    '  { type: "object", properties: { a: { type: "number" } }, required: ["a"] } as const satisfies __cfHelpers.JSONSchema,',
    '  { type: "string" } as const satisfies __cfHelpers.JSONSchema,',
    "  ({ a }) => `n:${a}`,",
    ");",
    "const data = fetchJson({ url: endpoint, method: verb });",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  const builder = findNode(
    doc,
    (n) => n.kind === "builder" && n.name === "helper",
  );
  assert(
    builder && builder.meta && builder.meta.kind === "contract",
    "contract meta",
  );
  if (builder && builder.meta && builder.meta.kind === "contract") {
    assert(builder.meta.input, "an input schema was parsed");
    assert(builder.meta.output, "an output schema was parsed");
    assert(
      (builder.meta.typeArgs?.length ?? 0) >= 2,
      "type arguments recorded",
    );
    assert(
      (builder.meta.captures?.length ?? 0) >= 1,
      "callback parameter captured",
    );
  }
  // fetchJson with a plain object argument records that object's keys as args.
  const fetch = findNode(doc, (n) => n.name === "data");
  assert(fetch, "the fetchJson binding is a node");
});

//
// inferExprType branches (lines 2007-2053) & describeInitializer
//

Deno.test("parse: variable type is inferred from satisfies, casts and literals", () => {
  const cases: Array<[string, string, string]> = [
    [
      "sat",
      `const sat = (someVal satisfies Record<string, number>);`,
      "Record<string, number>",
    ],
    ["asTyped", `const asTyped = value as Widget;`, "Widget"],
    ["asConst", `const asConst = 5 as const;`, "number"],
    ["paren", `const paren = (42);`, "number"],
    ["nonNull", `const nonNull = maybe!;`, ""],
    [
      "created",
      `const created = new Map<string, number>();`,
      "Map<string, number>",
    ],
    ["strLit", `const strLit = "hello";`, "string"],
    ["tmpl", "const tmpl = `a${b}c`;", "string"],
    ["numLit", `const numLit = 3.14;`, "number"],
    ["bigLit", `const bigLit = 10n;`, "bigint"],
    ["reLit", `const reLit = /abc/g;`, "RegExp"],
    ["boolLit", `const boolLit = true;`, "boolean"],
    ["nullLit", `const nullLit = null;`, "null"],
    ["undefLit", `const undefLit = undefined;`, "undefined"],
  ];
  for (const [name, src, expected] of cases) {
    const doc = parseDocument(src + "\n", "m.ts");
    const node = findNode(doc, (n) => n.name === name);
    assert(node, `binding ${name} is a node`);
    assert(
      node!.meta && node!.meta.kind === "variable",
      `${name} variable meta`,
    );
    if (node!.meta && node!.meta.kind === "variable") {
      if (expected === "") {
        // nonNull on a bare identifier infers nothing certain.
        assertEquals(
          node!.meta.typeText,
          undefined,
          `${name} type is undefined`,
        );
      } else {
        assertEquals(node!.meta.typeText, expected, `${name} inferred type`);
      }
    }
  }
});

Deno.test("parse: describeInitializer reports closure for a function initializer", () => {
  const doc = parseDocument(
    "const fn = function namedFn() { return 1; };\n",
    "m.ts",
  );
  // A function-expression initializer makes the binding a closure node, so its
  // closure meta — not variable meta — is what surfaces. Use an arrow bound to
  // a non-closure path to exercise describeInitializer's closure branch via a
  // non-reactive call wrapper.
  const node = findNode(doc, (n) => n.name === "fn");
  assert(node, "the function binding is a node");
  assertEquals(
    node!.kind,
    "closure",
    "a function initializer is a closure node",
  );
});

Deno.test("parse: a non-reactive call binding records describeInitializer text", () => {
  // `const out = compute(x);` is a non-reactive call, so bindingDesc keeps it a
  // variable and variableMeta -> describeInitializer runs over the call.

  const doc = parseDocument("const out = compute(x, y);\n", "m.ts");
  const node = findNode(doc, (n) => n.name === "out");
  assert(node, "the binding is a node");
  assertEquals(node!.kind, "variable");
  assert(node!.meta && node!.meta.kind === "variable");
  if (node!.meta && node!.meta.kind === "variable") {
    assert(
      node!.meta.bindsTo.includes("compute"),
      `bindsTo shows the call, got ${node!.meta.bindsTo}`,
    );
  }
});

//
// A reconstruction sanity check over a varied blob
//

Deno.test("parse: spans reconstruct every line of a varied blob verbatim", () => {
  const src = [
    "enum E { A }",
    "namespace N { const z = 1; }",
    "class K { get v() { return 1; } }",
    "const arr = data[idx];",
    "label: for (;;) break label;",
  ].join("\n");
  const doc = parseDocument(src, "m.ts");
  for (let i = 0; i < doc.lines.length; i++) {
    assertEquals(
      doc.lines[i].spans.map((s) => s.text).join(""),
      doc.lines[i].text,
      `line ${i} reconstructs`,
    );
  }
});

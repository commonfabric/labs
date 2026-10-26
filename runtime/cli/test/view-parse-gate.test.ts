/**
 * Behavioral tests for the parse paths the coverage gate flagged in
 * `lib/view/languages/typescript/parse.ts`. The dead and duplicate branches at those lines were
 * removed or folded away at the source; these tests exercise the reachable
 * behavior that remains, through the public API:
 *
 *   - classifyIdentifier: a leaf identifier is classified by its parent.
 *   - isTypePosition: a qualified name, a `typeof` operand, and a class or
 *     interface heritage type each resolve as a type position.
 *   - mergeByStart: comment batches thread into their host node.
 *   - registerDefinition: a named declaration is registered; an anonymous one
 *     is not.
 *   - controlLabel: every control-statement kind, including try, gets a label.
 *   - safe: metadata extraction stays intact on malformed input.
 *   - describeInitializer: an initializer is described by its first line.
 */

import { assert, assertEquals } from "@std/assert";
import {
  createHighlighter,
  highlightDocument,
  parseDocument,
} from "../lib/view/languages/typescript/parse.ts";
import type { Document, StructureNode, TokenClass } from "../lib/view/model.ts";

/** Every token class the literal text `token` is assigned across `doc`. */
function classesOf(doc: Document, token: string): Set<TokenClass> {
  const set = new Set<TokenClass>();
  for (const line of doc.lines) {
    for (const span of line.spans) {
      if (span.text === token) set.add(span.cls);
    }
  }
  return set;
}

function find(
  doc: Document,
  pred: (n: StructureNode) => boolean,
): StructureNode | undefined {
  return doc.flatStructure.find(pred);
}

function byName(doc: Document, name: string): StructureNode | undefined {
  return doc.flatStructure.find((n) => n.name === name);
}

//
// 836: classifyIdentifier with a parent (the only reachable case)
//

Deno.test("gate 836: leaf identifiers are classified by their parent context", () => {
  // `if (!p) …` is the parentless fall-through. Every identifier in a parsed
  // file has a parent, so the classification always proceeds past it. Drive the
  // declaration, call and property-access branches that run instead.
  const doc = parseDocument(
    [
      "function build(seed) { return seed; }",
      "const made = build(1);",
      "made.toString();",
    ].join("\n"),
  );
  assert(
    classesOf(doc, "build").has("functionName"),
    "function declaration name is a functionName",
  );
  assert(
    classesOf(doc, "build").has("callName"),
    "the bare call `build(1)` is a callName",
  );
  assert(
    classesOf(doc, "made").has("binding"),
    "`made` is a binding at its declaration",
  );
  assert(
    classesOf(doc, "toString").has("propertyName"),
    "the member call `.toString()` keeps its propertyName classification",
  );
  assert(
    doc.lines.flatMap((line) => line.spans).some((span) =>
      span.text === "toString" && span.exactDefinitionName === "toString"
    ),
    "the member call uses exact-position definition lookup",
  );
});

Deno.test("called element keys carry one exact-position lookup marker", () => {
  const doc = parseDocument(
    "worker[-1](); worker[+1](); worker[`line one\nline two`]();",
  );
  assertEquals(
    doc.lines.flatMap((line) => line.spans)
      .filter((span) => span.exactDefinitionName !== undefined)
      .map((span) => [
        span.text,
        span.exactDefinitionName,
        span.exactDefinitionDisplayName,
      ]),
    [
      ["1", "-1", "-1"],
      ["1", "+1", "+1"],
      ["`line one", "line one\nline two", '"line one\\nline two"'],
    ],
  );
});

//
// 913: a qualified name in type position always has a parent
//

Deno.test("gate 913: a qualified name in a type annotation resolves as a type", () => {
  // isTypePosition climbs the qualified-name chain (`outer.inner.Leaf`) and then
  // checks the parent. The top of the chain is a TypeReference, never
  // parentless, so the `if (!p) return false` guard is skipped and the leaf
  // resolves as a typeName.
  const doc = parseDocument("let handle: outer.inner.Leaf = null as never;");
  assert(
    classesOf(doc, "Leaf").has("typeName"),
    `expected Leaf to be a typeName, got ${[...classesOf(doc, "Leaf")]}`,
  );
});

//
// 916: typeof type resolves via ts.isTypeNode before the TypeQuery branch -
//

Deno.test("gate 916: a `typeof` type colors its operand as a type name", () => {
  // `typeof base` as a type makes `base`'s parent a TypeQueryNode. Because a
  // TypeQueryNode is itself a TypeNode, isTypePosition returns at the
  // ts.isTypeNode check above; the dedicated isTypeQueryNode branch never runs.
  const doc = parseDocument("const base = 1;\nlet copy: typeof base = base;");
  assert(
    classesOf(doc, "base").has("typeName"),
    `expected a typeName base, got ${[...classesOf(doc, "base")]}`,
  );
});

//
// 917, 919, 920: heritage types resolve via ts.isTypeNode first
//

Deno.test("gate 917-920: a class heritage type colors as a type name", () => {
  // `extends Parent<number>` produces an ExpressionWithTypeArguments whose
  // expression is `Parent`. That node is also a TypeNode, so `Parent` resolves
  // as a typeName at the ts.isTypeNode check, never reaching the
  // ExpressionWithTypeArguments branch.
  const doc = parseDocument("class Child extends Parent<number> {}");
  assert(
    classesOf(doc, "Parent").has("typeName"),
    `expected Parent to be a typeName, got ${[...classesOf(doc, "Parent")]}`,
  );
});

Deno.test("gate 917-920: an interface heritage type colors as a type name", () => {
  const doc = parseDocument("interface Sub extends Sup { z: number }");
  assert(
    classesOf(doc, "Sup").has("typeName"),
    `expected Sup to be a typeName, got ${[...classesOf(doc, "Sup")]}`,
  );
});

//
// 1225: mergeByStart only ever runs with a non-empty additions batch
//

Deno.test("gate 1225: comment batches (always non-empty) merge into their host", () => {
  // insertComments pushes a comment node into a batch before merging it, so
  // mergeByStart is never called with an empty additions array. A nested
  // comment under a function proves the per-host batch merge ran in order.
  const doc = parseDocument(
    [
      "// top note",
      "function host() {",
      "  // inner note",
      "  return 1;",
      "}",
      "// tail note",
    ].join("\n"),
  );
  const comments = doc.flatStructure.filter((n) => n.kind === "comment");
  assertEquals(comments.length, 3, "all three comments are threaded in");
  const inner = comments.find((c) => /inner note/.test(c.label));
  assert(inner, "the inner comment is present");
  // The inner comment is nested deeper than a top-level comment (it lives under
  // the function), confirming a batch was merged into the function's children.
  const top = comments.find((c) => /top note/.test(c.label))!;
  assert(
    inner!.depth > top.depth,
    `inner comment should nest deeper (inner=${
      inner!.depth
    }, top=${top.depth})`,
  );
});

//
// 1270: registerDefinition is only called for named declarations
//

Deno.test("gate 1270: named declarations are registered; an anonymous one is not", () => {
  // The caller guards `registerDefinition` with `if (desc.name)`, so the
  // `if (!desc.name) return` guard inside it is never reached. Named forms
  // register; a default-export arrow (no binding name) does not pollute the
  // definition index.
  const doc = parseDocument(
    [
      "function namedFn() {}",
      "const namedConst = 7;",
      "class NamedClass {}",
      "export default () => 0;",
    ].join("\n"),
  );
  assert(doc.definitions.has("namedFn"), "namedFn registered");
  assert(doc.definitions.has("namedConst"), "namedConst registered");
  assert(doc.definitions.has("NamedClass"), "NamedClass registered");
  const named = doc.definitions.get("namedFn")!;
  assertEquals(named[0].name, "namedFn");
  // The anonymous default export contributes no empty-named definition entry.
  assert(
    ![...doc.definitions.keys()].some((k) => k === ""),
    "no empty-named definition was registered",
  );
});

//
// 1668: controlLabel's eight handled kinds (the fall-through never runs)
//

Deno.test("gate 1668: every control statement gets its dedicated label", () => {
  // controlLabel runs only for the eight isControlStatement kinds, each with an
  // explicit branch above the final nodeFirstLine fall-through. Drive all eight.
  const doc = parseDocument(
    [
      "if (a) { f(); }",
      "while (a) { f(); }",
      "do { f(); } while (a);",
      "switch (a) { case 1: break; }",
      "for (;;) { f(); }",
      "for (const x of xs) { f(); }",
      "for (const y in ys) { f(); }",
      "try { f(); } catch (e) { g(e); }",
    ].join("\n"),
  );
  const labels = doc.flatStructure.map((n) => n.label);
  const has = (re: RegExp) => labels.some((l) => re.test(l));
  assert(has(/^if \(/), "if label");
  assert(has(/^while \(/), "while label");
  assert(has(/^do … while$/), "do…while label");
  assert(has(/^switch \(/), "switch label");
  assert(has(/^for \(…\)$/), "for label");
  assert(has(/^for \(… of …\)$/), "for-of label");
  assert(has(/^for \(… in …\)$/), "for-in label");
  assert(has(/^try$/), "try label");
});

//
// 1719-1721: safe()'s wrapped extractors never throw on parseable input
//

Deno.test("gate 1719-1721: metadata extraction never throws on malformed input", () => {
  // Each input parses (via TypeScript error recovery) into nodes with valid
  // ranges, so every safe()-wrapped extractor runs its body without throwing
  // and the catch is never taken. The parse and a re-highlight both succeed.
  const cases = [
    "type Bad = ;",
    "interface Q extends { }",
    "import from 'x';",
    "const s = { type: } as const satisfies Schema;",
    "function f<>() {}",
    "const m = new Map<>();",
    "const c = lift<>(x);",
    "const f = (a:) => a;",
    "type T = import().Foo;",
    "const x = a as ;",
  ];
  for (const c of cases) {
    const doc = parseDocument(c);
    assert(doc.flatStructure.length >= 1, `no structure for: ${c}`);
    assert(highlightDocument(c).length >= 1, `no lines for: ${c}`);
  }
});

Deno.test("gate 1719-1721: safe() returns the value when the extractor succeeds", () => {
  // The non-throwing path of safe() is the import-metadata extractor, exercised
  // here so the surrounding wrapper is covered alongside the catch reasoning.
  const doc = parseDocument(
    [
      "import def, { named, other as alias } from 'mod';",
      "import * as ns from 'space';",
    ].join("\n"),
  );
  const imp = find(doc, (n) => n.kind === "import" && n.meta !== undefined);
  assert(imp, "an import node carries metadata");
  const meta = imp!.meta!;
  assertEquals(meta.kind, "import");
  if (meta.kind === "import") {
    assert(meta.names.includes("named"), "named import recorded");
    assertEquals(meta.module, "mod");
  }
});

//
// 2045-2047: describeInitializer never sees a raw arrow initializer
//

Deno.test("gate 2045-2047: an arrow initializer becomes a closure node", () => {
  // bindingDesc peels the initializer and routes any arrow / function
  // expression to a dedicated closure node (with closureMeta), so variableMeta
  // — and therefore describeInitializer's closure branch — is never reached for
  // an arrow. The binding is a closure, not a variable.
  for (
    const src of ["const handler = () => 1;", "const wrapped = (() => 2);"]
  ) {
    const doc = parseDocument(src);
    const node = byName(doc, src.includes("handler") ? "handler" : "wrapped");
    assert(node, `expected a node for ${src}`);
    assertEquals(node!.kind, "closure", `${src} is a closure node`);
    assert(
      node!.meta?.kind === "closure",
      `${src} carries closure meta, not variable meta`,
    );
  }
});

Deno.test("gate 2045-2047: describeInitializer reports the reachable non-closure cases", () => {
  // The reachable describeInitializer outputs: the uninitialized sentinel and
  // the nodeFirstLine fall-through for a non-arrow initializer. Neither is the
  // "closure" string, confirming that branch stays dead for variable nodes.
  const doc = parseDocument(
    [
      "let pending;",
      "const result = computeValue();",
      "const total = left + right;",
    ].join("\n"),
  );
  const pending = byName(doc, "pending")!;
  assert(pending, "node for pending");
  assertEquals(pending.meta?.kind, "variable");
  assertEquals(
    (pending.meta as { bindsTo?: string }).bindsTo,
    "(uninitialized)",
  );

  const total = byName(doc, "total")!;
  assert(total, "node for total");
  assertEquals(total.meta?.kind, "variable");
  const bindsTo = (total.meta as { bindsTo?: string }).bindsTo;
  assert(
    typeof bindsTo === "string" && bindsTo.length > 0 && bindsTo !== "closure",
    `expected a non-closure description, got ${bindsTo}`,
  );
});

Deno.test("gate 2045-2047: incremental highlighter re-highlights an edited closure line", () => {
  // Editing a line into an arrow keeps the byte-for-byte text and re-colors the
  // arrow token, exercising the incremental path that feeds the same classifier
  // and binding routing as a full parse.
  const h = createHighlighter("const a = 1;\nconst b = 2;\n");
  const before = h.lines.length;
  const after = h.update("const a = 1;\nconst b = () => 2;\n");
  assertEquals(after.length, before, "line count is unchanged by the edit");
  const joined = after.map((l) => l.spans.map((s) => s.text).join("")).join(
    "\n",
  );
  assertEquals(
    joined,
    "const a = 1;\nconst b = () => 2;\n",
    "the edited text is reproduced verbatim",
  );
});

import { assert, assertEquals } from "@std/assert";
import { parseDocument } from "./view-helpers.ts";
import { buildPeekCard } from "../lib/view/card.ts";
import type {
  Document,
  Line,
  Span,
  StructureNode,
  TokenClass,
} from "../lib/view/model.ts";
import type { DefTarget, Semantics } from "../lib/view/languages/language.ts";

function infoText(doc: Document, node: StructureNode, semantics?: Semantics) {
  return buildPeekCard(doc, node, semantics).info.map((l) => l.text).join("\n");
}

function findByLabel(doc: Document, label: string): StructureNode {
  const node = doc.flatStructure.find((n) => n.label === label);
  assert(node, `no node labeled "${label}"`);
  return node!;
}

//
// card title + "merges" line for merged generic AST nodes
//

Deno.test("card: a merged generic node names every AST kind it merges", () => {
  // In `a as B`, the type annotation `B` is a TypeReference whose sole child is
  // the Identifier `B` over the same source range, so they merge into one
  // navigable node carrying both AST kinds.
  const doc = parseDocument(`// transformed: /app.ts
const x = a as B;
`);
  const clause = findByLabel(doc, "B");
  assertEquals(clause.kind, "node");
  assert(
    clause.astKinds && clause.astKinds.length > 1,
    "the node merges more than one AST node",
  );
  const card = buildPeekCard(doc, clause);
  const text = card.info.map((l) => l.text).join("\n");
  // The card title for a generic node leads with the joined AST kinds.
  assert(
    card.title.includes("TypeReference + Identifier"),
    `generic-node title joins kinds: ${card.title}`,
  );
  // The "merges" line spells out the merged kinds, dot-separated.
  assert(
    text.includes("merges") && text.includes("TypeReference · Identifier"),
    `merges line present: ${text}`,
  );
});

Deno.test("card: a single-kind generic node title shows its one AST kind", () => {
  const doc = parseDocument(`// transformed: /app.ts
foo();
`);
  // `foo` (an Identifier) is a generic node with exactly one AST kind, so the
  // title joins to just that kind and there is no "merges" line.
  const ident = findByLabel(doc, "foo");
  assertEquals(ident.kind, "node");
  const card = buildPeekCard(doc, ident);
  assert(card.title.startsWith("Identifier"), `title: ${card.title}`);
  const text = card.info.map((l) => l.text).join("\n");
  assert(!text.includes("merges"), "no merges line for a single-kind node");
});

Deno.test("card: a node with no AST kinds falls back to its structure kind", () => {
  // A synthetic node carrying no astKinds exercises the title fallback that
  // uses the structure kind instead of a joined AST-kind string.
  const node: StructureNode = {
    kind: "node",
    label: "mystery",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 7,
    startOffset: 0,
    endOffset: 7,
    depth: 0,
    children: [],
  };
  const doc: Document = {
    text: "mystery\n",
    lines: [{ text: "mystery", spans: [] }, { text: "", spans: [] }],
    structure: [node],
    flatStructure: [node],
    definitions: new Map(),
  };
  const card = buildPeekCard(doc, node);
  assertEquals(card.title, "node  mystery");
});

//
// detail sections by meta kind
//

Deno.test("card: a schema node renders its labeled type", () => {
  const doc = parseDocument(`// transformed: /app.ts
const __cfLift_1 = lift({
    type: "object",
    properties: { token: { type: "string" } },
    required: ["token"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, ({ token }) => token);
`);
  const schemaNode = doc.flatStructure.find((n) => n.meta?.kind === "schema");
  assert(schemaNode, "found a schema-meta node");
  const text = infoText(doc, schemaNode!);
  // detailSection's "schema" branch routes through schemaSection("schema", …).
  assert(
    text.toLowerCase().includes("schema"),
    `schema label present: ${text}`,
  );
  assert(text.includes("token"), "renders the schema field");
});

Deno.test("card: an import with named bindings lists the imported names", () => {
  const doc = parseDocument(`// transformed: /app.ts
import { lift, pattern } from "commonfabric";
`);
  const imp = doc.flatStructure.find((n) => n.meta?.kind === "import");
  assert(imp, "found the import node");
  const text = infoText(doc, imp!);
  assert(text.includes("imports") && text.includes("lift, pattern"), text);
  assert(text.includes("from") && text.includes('"commonfabric"'), text);
});

Deno.test("card: a side-effect import shows the side-effect marker", () => {
  const doc = parseDocument(`// transformed: /app.ts
import "polyfill";
`);
  const imp = doc.flatStructure.find((n) =>
    n.meta?.kind === "import" && n.meta.names.length === 0
  );
  assert(imp, "found the side-effect import");
  const text = infoText(doc, imp!);
  assert(text.includes("(side-effect)"), `side-effect marker: ${text}`);
  assert(text.includes('"polyfill"'), "names the module");
});

Deno.test("card: a type alias to a named type shows its alias text", () => {
  const doc = parseDocument(`// transformed: /app.ts
type Alias = SomeOther;
`);
  const alias = findByLabel(doc, "type Alias");
  assertEquals(alias.meta?.kind, "type");
  const text = infoText(doc, alias);
  // typeDetail with no members but an aliasText emits `= SomeOther`.
  assert(text.includes("= SomeOther"), `alias text rendered: ${text}`);
});

Deno.test("card: an empty interface emits no member detail", () => {
  const doc = parseDocument(`// transformed: /app.ts
interface Empty {}
`);
  const empty = findByLabel(doc, "interface Empty");
  assertEquals(empty.meta?.kind, "type");
  if (empty.meta?.kind === "type") {
    assertEquals(empty.meta.members.length, 0);
    assertEquals(empty.meta.aliasText, undefined);
  }
  const card = buildPeekCard(doc, empty);
  // typeDetail returns [] (no members, no aliasText), so no MEMBERS heading.
  const text = card.info.map((l) => l.text).join("\n");
  assert(!text.includes("MEMBERS"), `no members heading: ${text}`);
  // The card is still well-formed: a title and the meta/origin lines exist.
  assert(card.title.includes("interface Empty"));
});

Deno.test("card: a closure returning an object shows its return keys", () => {
  const doc = parseDocument(`// transformed: /app.ts
const make = () => { return { url: 1, ok: 2 }; };
`);
  const make = findByLabel(doc, "λ make");
  assertEquals(make.meta?.kind, "closure");
  if (make.meta?.kind === "closure") {
    assertEquals([...make.meta.returns ?? []], ["url", "ok"]);
  }
  const text = infoText(doc, make);
  // closureDetail's returns branch renders `{ url, ok }`.
  assert(text.includes("returns") && text.includes("{ url, ok }"), text);
  // This closure is untyped, so no signature line is shown.
  assert(!text.includes("signature"), "untyped closure has no signature line");
});

Deno.test("card: a contract that calls inner builders lists them", () => {
  const doc = parseDocument(
    `// transformed: /app.ts
const __cfLift_1 = lift({ type: "object" } as const satisfies __cfHelpers.JSONSchema, { type: "object" } as const satisfies __cfHelpers.JSONSchema, () => {
  return computed(() => 1);
});
`,
  );
  const lift = doc.flatStructure.find((n) =>
    n.kind === "builder" && n.name === "__cfLift_1"
  )!;
  assert(lift, "found the lift");
  if (lift.meta?.kind === "contract") {
    assert(lift.meta.innerBuilders.includes("computed"), "calls computed");
  }
  const text = infoText(doc, lift);
  // contractDetail's innerBuilders branch emits a `calls  computed` line.
  assert(text.includes("calls") && text.includes("computed"), text);
});

//
// outline overflow + glyphs
//

Deno.test("card: an outline past the cap shows a trailing 'N more' line", () => {
  let src = "// transformed: /app.ts\n";
  for (let i = 0; i < 16; i++) src += `const v${i} = ${i};\n`;
  const doc = parseDocument(src);
  const section = doc.flatStructure.find((n) => n.kind === "section")!;
  const text = infoText(doc, section);
  assert(text.includes("OUTLINE · 16"), `outline counts all children: ${text}`);
  // 16 children, MAX_CHILDREN 14, so two are folded into a "2 more" line.
  assert(text.includes("2 more"), `overflow line present: ${text}`);
});

Deno.test("card: the 'N more' line is a selectable expand target; expanding shows all", () => {
  let src = "// transformed: /app.ts\n";
  for (let i = 0; i < 16; i++) src += `const v${i} = ${i};\n`;
  const doc = parseDocument(src);
  const section = doc.flatStructure.find((n) => n.kind === "section")!;
  const card = buildPeekCard(doc, section);
  // The "… 2 more" line is a target, flagged expand, pointing at its own line.
  const moreLine = card.info.findIndex((l) => l.text.includes("2 more"));
  const expandTarget = card.targets.find((t) => t.expand);
  assert(expandTarget, "the more line is a target");
  assertEquals(expandTarget!.cardLine, moreLine, "it points at the more line");
  // Rebuilding expanded lists every child and drops the more line (and its
  // expand target).
  const full = buildPeekCard(doc, section, undefined, true);
  const fullText = full.info.map((l) => l.text).join("\n");
  assert(
    !fullText.includes("more"),
    `no overflow line when expanded: ${fullText}`,
  );
  assert(fullText.includes("v15"), "the last child is now listed");
  assert(!full.targets.some((t) => t.expand), "no expand target when expanded");
});

Deno.test("card: the outline picks a glyph for each child kind", () => {
  // A synthetic parent whose children span the glyph cases reachable from the
  // outline (which hoists through, and so never lists, generic node/comment
  // children).
  const kinds: Array<StructureNode["kind"]> = [
    "section",
    "function",
    "method",
    "control",
    "hunk",
    "export", // hits the default glyph
  ];
  const children: StructureNode[] = kinds.map((kind, i) => ({
    kind,
    label: `child_${kind}`,
    startLine: i + 1,
    endLine: i + 1,
    startCol: 0,
    endCol: 5,
    startOffset: (i + 1) * 10,
    endOffset: (i + 1) * 10 + 5,
    depth: 1,
    children: [],
  }));
  const parent: StructureNode = {
    kind: "function",
    label: "parent",
    startLine: 0,
    endLine: kinds.length + 1,
    startCol: 0,
    endCol: 6,
    startOffset: 0,
    endOffset: 999,
    depth: 0,
    children,
  };
  const flat = [parent, ...children];
  const lines: Line[] = Array.from(
    { length: kinds.length + 2 },
    () => ({ text: "", spans: [] }),
  );
  const doc: Document = {
    text: "\n".repeat(kinds.length + 2),
    lines,
    structure: [parent],
    flatStructure: flat,
    definitions: new Map(),
  };
  const text = infoText(doc, parent);
  assert(text.includes("OUTLINE · 6"), `lists all children: ${text}`);
  assert(text.includes("▸"), "section glyph");
  assert(text.includes("ƒ"), "function/method glyph");
  assert(text.includes("⎇"), "control glyph");
  assert(text.includes("±"), "hunk glyph");
  // The `export` child has no dedicated glyph and falls back to `·`.
  assert(text.includes("·"), "default glyph for an unmapped kind");
});

Deno.test("card: the outline glyphs cover pattern/builder/closure/schema/type/import/return", () => {
  const kinds: Array<StructureNode["kind"]> = [
    "pattern",
    "builder",
    "closure",
    "schema",
    "interface",
    "import",
    "return",
  ];
  const children: StructureNode[] = kinds.map((kind, i) => ({
    kind,
    label: `child_${kind}`,
    startLine: i + 1,
    endLine: i + 1,
    startCol: 0,
    endCol: 5,
    startOffset: (i + 1) * 10,
    endOffset: (i + 1) * 10 + 5,
    depth: 1,
    children: [],
  }));
  const parent: StructureNode = {
    kind: "function",
    label: "parent",
    startLine: 0,
    endLine: kinds.length + 1,
    startCol: 0,
    endCol: 6,
    startOffset: 0,
    endOffset: 999,
    depth: 0,
    children,
  };
  const flat = [parent, ...children];
  const lines: Line[] = Array.from(
    { length: kinds.length + 2 },
    () => ({ text: "", spans: [] }),
  );
  const doc: Document = {
    text: "\n".repeat(kinds.length + 2),
    lines,
    structure: [parent],
    flatStructure: flat,
    definitions: new Map(),
  };
  const text = infoText(doc, parent);
  assert(text.includes("◆"), "pattern glyph");
  assert(text.includes("◇"), "builder glyph");
  assert(text.includes("λ"), "closure glyph");
  assert(text.includes("▦"), "schema glyph");
  assert(text.includes("𝑻"), "interface glyph");
  assert(text.includes("⇤"), "import glyph");
  assert(text.includes("⏎"), "return glyph");
});

//
// uses overflow
//

Deno.test("card: more than ten uses fold into a 'N more' line", () => {
  let src = "// transformed: /app.ts\nconst target = 1;\n";
  for (let i = 0; i < 13; i++) src += `const u${i} = target + ${i};\n`;
  const doc = parseDocument(src);
  const node = doc.flatStructure.find((n) => n.name === "target")!;
  const text = infoText(doc, node);
  assert(text.includes("USES · 13"), `counts all uses: ${text}`);
  assert(text.includes("declared  line 2"), "shows where it is declared");
  // 13 uses, MAX_USES 10, so three are folded.
  assert(text.includes("3 more"), `uses overflow line: ${text}`);
});

//
// deps overflow
//

Deno.test("card: more than ten dependencies fold into a 'N more' line", () => {
  let src = "// transformed: /app.ts\n";
  for (let i = 0; i < 12; i++) src += `const dep${i} = ${i};\n`;
  src += "function consumer() {\n  return " +
    Array.from({ length: 12 }, (_, i) => `dep${i}`).join(" + ") + ";\n}\n";
  const doc = parseDocument(src);
  const node = doc.flatStructure.find((n) => n.name === "consumer")!;
  const text = infoText(doc, node);
  assert(text.includes("DEPENDS ON · 10"), `caps the listed deps: ${text}`);
  // 12 deps, MAX_DEPS 10, so two are folded.
  assert(text.includes("2 more"), `deps overflow line: ${text}`);
});

//
// dependency jump through the semantic service
//

/** A fake semantic service whose `definitionOf` ignores the query offset and
 * returns a fixed result, so a card can be driven down a chosen resolution
 * path without a real TypeScript program. */
function fakeSemantics(
  defs: DefTarget[] | ((offset: number) => DefTarget[]),
): Semantics {
  return {
    typeAt: () => null,
    definitionOf: (offset: number) =>
      typeof defs === "function" ? defs(offset) : defs,
    fileLines: () => null,
    prewarm: () => {},
  };
}

Deno.test("card: deferred semantic dependencies remain in the folded count", () => {
  let src = "// transformed: /app.ts\n";
  for (let i = 0; i < 41; i++) src += `const dep${i} = ${i};\n`;
  src += "function consumer() {\n  return " +
    Array.from({ length: 41 }, (_, i) => `dep${i}`).join(" + ") + ";\n}\n";
  const doc = parseDocument(src);
  const consumer = doc.flatStructure.find((n) => n.name === "consumer")!;
  const first = doc.flatStructure.find((n) => n.name === "dep0")!;
  let definitionCalls = 0;
  const semantics = fakeSemantics(() => {
    definitionCalls++;
    return [{
      name: "dep0",
      blobOffset: first.startOffset,
      line: first.startLine,
      preview: "const dep0 = 0;",
    }];
  });

  const text = infoText(doc, consumer, semantics);
  assertEquals(
    definitionCalls,
    40,
    "the collapsed card keeps semantic lookup within its prefix",
  );
  assert(
    text.includes("30 more"),
    `all resolved folded dependencies are counted: ${text}`,
  );
  assert(
    text.includes("1 possible dependency"),
    `the unresolved dependency is counted without a speculative row: ${text}`,
  );
  assert(
    text.includes("1 remaining use"),
    `the deferred semantic use can still be expanded: ${text}`,
  );
});

Deno.test("card: a deferred dependency does not use a same-named local jump", () => {
  let src = "// transformed: /app.ts\nconst ext = 1;\n";
  src += "function consumer() {\n";
  for (let i = 0; i < 40; i++) src += `  unknown${i};\n`;
  src += "  return ext();\n}\n";
  const doc = parseDocument(src);
  const consumer = doc.flatStructure.find((n) => n.name === "consumer")!;
  const localExt = doc.flatStructure.find((n) => n.name === "ext")!;
  const semantics = fakeSemantics((offset) =>
    doc.text.slice(offset, offset + 3) === "ext"
      ? [{
        name: "ext",
        filePath: "/workspace/external.ts",
        fileOffset: 0,
        line: 0,
        col: 0,
        preview: "export function ext() {}",
      }]
      : []
  );

  const collapsed = buildPeekCard(doc, consumer, semantics);
  const collapsedText = collapsed.info.map((line) => line.text).join("\n");
  assert(
    !collapsedText.split("\n").some((line) => line.startsWith("  ext  ")),
    `the deferred use has no speculative local row: ${collapsedText}`,
  );
  assert(
    !collapsed.targets.some((target) =>
      target.defOffset === localExt.startOffset
    ),
    `the deferred use has no speculative local jump: ${collapsedText}`,
  );
  assert(
    collapsedText.includes("1 remaining use"),
    `the unresolved use can be expanded: ${collapsedText}`,
  );
  assert(
    collapsedText.includes("1 possible dependency"),
    `the syntactic match is labeled as unresolved: ${collapsedText}`,
  );

  const expanded = buildPeekCard(doc, consumer, semantics, true);
  const expandedText = expanded.info.map((line) => line.text).join("\n");
  assert(
    expandedText.includes("  ext  external.ts:1"),
    `expansion shows the semantic external target: ${expandedText}`,
  );
  assert(
    expanded.targets.some((target) =>
      target.filePath === "/workspace/external.ts"
    ),
    "the expanded row jumps to the external definition",
  );
});

Deno.test("card: a call target defined inside the selected node is not a dependency", () => {
  const doc = parseDocument(`// transformed: /app.ts
function consumer() {
  const worker = { run(): void {} };
  worker.run();
}
`);
  const consumer = doc.flatStructure.find((n) => n.name === "consumer")!;
  const method = doc.flatStructure.find((n) =>
    n.kind === "method" && n.name === "run"
  )!;
  let resolvedCalls = 0;
  const semantics = fakeSemantics((offset) => {
    if (doc.text.slice(offset, offset + 3) !== "run") return [];
    resolvedCalls++;
    return [{
      name: "run",
      blobOffset: method.startOffset,
      line: method.startLine,
      preview: method.label,
    }];
  });

  const text = infoText(doc, consumer, semantics);
  assert(resolvedCalls > 0, "the call target is resolved");
  assert(
    !text.includes("DEPENDS ON"),
    `a definition inside the selected function is omitted: ${text}`,
  );
});

Deno.test("card: repeated calls to one target produce one dependency", () => {
  const doc = parseDocument(`// transformed: /app.ts
const worker = { run(): void {} };
[worker.run(), worker.run()];
`);
  const statement = doc.flatStructure.find((n) =>
    n.kind === "statement" && n.startLine === 2
  )!;
  const worker = doc.flatStructure.find((n) => n.name === "worker")!;
  const method = doc.flatStructure.find((n) =>
    n.kind === "method" && n.name === "run"
  )!;
  const semantics = fakeSemantics((offset) => {
    const target = doc.text.slice(offset, offset + 3) === "run"
      ? method
      : worker;
    return [{
      name: target.name!,
      blobOffset: target.startOffset,
      line: target.startLine,
      preview: target.label,
    }];
  });

  const text = infoText(doc, statement, semantics);
  assertEquals(
    text.split("\n").filter((line) => line.startsWith("  run  ")).length,
    1,
    `the repeated target has one row: ${text}`,
  );
});

Deno.test("card: a dependency that resolves in-blob jumps to its enclosing node", () => {
  const doc = parseDocument(`// transformed: /app.ts
const helper = 1;
function consumer() {
  return helper;
}
`);
  const helper = doc.flatStructure.find((n) => n.name === "helper")!;
  const consumer = doc.flatStructure.find((n) => n.name === "consumer")!;
  // Resolve every dependency to a blob offset that lands inside the `helper`
  // declaration, so dependencyJump finds an enclosing node.
  const semantics = fakeSemantics([
    {
      name: "helper",
      blobOffset: helper.startOffset + 1,
      line: helper.startLine,
      preview: "const helper = 1;",
    },
  ]);
  const card = buildPeekCard(doc, consumer, semantics);
  const text = card.info.map((l) => l.text).join("\n");
  assert(text.includes("DEPENDS ON"), `has a deps section: ${text}`);
  const dep = card.targets.find((t) => t.defOffset === helper.startOffset);
  assert(dep, "dependency target points at the enclosing helper node");
  assertEquals(dep!.destLine, helper.startLine);
  assertEquals(dep!.defEndOffset, helper.endOffset);
});

Deno.test("card: a dependency whose blob offset is in no node jumps to the raw site", () => {
  const doc = parseDocument(`// transformed: /app.ts
const helper = 1;
function consumer() {
  return helper;
}
`);
  const consumer = doc.flatStructure.find((n) => n.name === "consumer")!;
  // A blob offset past the end of the document is inside no node at all, so
  // dependencyJump falls back to the blob line/offset it was handed.
  const farOffset = doc.text.length + 1000;
  const semantics = fakeSemantics([
    { name: "helper", blobOffset: farOffset, line: 7, preview: "anything" },
  ]);
  const card = buildPeekCard(doc, consumer, semantics);
  const dep = card.targets.find((t) => t.defOffset === farOffset);
  assert(dep, "falls back to the raw blob offset");
  assertEquals(dep!.destLine, 7);
  assertEquals(dep!.defEndOffset, undefined);
});

//
// external ("defined elsewhere") section
//

Deno.test("card: symbols resolving to a file land in 'defined elsewhere'", () => {
  const doc = parseDocument(`// transformed: /app.ts
function consumer() {
  return alpha + beta + gamma;
}
`);
  const consumer = doc.flatStructure.find((n) => n.name === "consumer")!;
  // Every identifier resolves to an out-of-blob file definition.
  const semantics = fakeSemantics((_offset) => [
    {
      name: "ext",
      filePath: "/somewhere/external.ts",
      fileOffset: 0,
      line: 41,
      preview: "export const x = 1;",
    },
  ]);
  const card = buildPeekCard(doc, consumer, semantics);
  const text = card.info.map((l) => l.text).join("\n");
  assert(text.includes("DEFINED ELSEWHERE"), `external section: ${text}`);
  assert(text.includes("external.ts:42"), `shows file:line: ${text}`);
  // Each external symbol is a target that carries the file path to open.
  const ext = card.targets.find((t) => t.filePath === "/somewhere/external.ts");
  assert(ext, "external target carries the file path");
  assertEquals(ext!.destLine, 41);
  // None of these resolve in-blob, so the deps section stays empty.
  assert(!text.includes("DEPENDS ON"), "no in-blob deps");
});

Deno.test("card: more than eight external symbols fold into a 'N more' line", () => {
  // Eleven distinct free identifiers, all resolving externally.
  const names = Array.from({ length: 11 }, (_, i) => `ext${i}`);
  let src = "// transformed: /app.ts\nfunction consumer() {\n  return ";
  src += names.join(" + ");
  src += ";\n}\n";
  const doc = parseDocument(src);
  const consumer = doc.flatStructure.find((n) => n.name === "consumer")!;
  const semantics = fakeSemantics((_offset) => [
    {
      name: "ext",
      filePath: "/somewhere/external.ts",
      fileOffset: 0,
      line: 5,
      preview: "x",
    },
  ]);
  const card = buildPeekCard(doc, consumer, semantics);
  const text = card.info.map((l) => l.text).join("\n");
  assert(text.includes("DEFINED ELSEWHERE · 8"), `caps at eight: ${text}`);
  // 11 externals, MAX_EXTERNAL 8, so three fold into a "more" line.
  assert(text.includes("3 more"), `external overflow line: ${text}`);
});

//
// schema rendering: scalar root + deeply nested multiline
//

/** Build a one-line `Line` of identifier spans for a synthetic document. */
function identLine(text: string): Line {
  const spans: Span[] = [];
  let col = 0;
  for (const word of text.split(/(\s+)/)) {
    if (word.length === 0) continue;
    const cls: TokenClass = /^\s+$/.test(word) ? "whitespace" : "identifier";
    spans.push({ col, text: word, cls });
    col += word.length;
  }
  return { text, spans };
}

Deno.test("card: a short scalar-root schema renders inline", () => {
  const node: StructureNode = {
    kind: "schema",
    label: "schema",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 6,
    startOffset: 0,
    endOffset: 6,
    depth: 0,
    children: [],
    meta: {
      kind: "schema",
      schema: { rootType: "string", required: [], fields: [] },
    },
  };
  const doc: Document = {
    text: "schema\n",
    lines: [identLine("schema"), { text: "", spans: [] }],
    structure: [node],
    flatStructure: [node],
    definitions: new Map(),
  };
  const text = infoText(doc, node);
  // The scalar root renders as the bare type keyword in the inline form.
  assert(text.includes("string"), `scalar schema renders its type: ${text}`);
});

Deno.test("card: a wide scalar-root schema renders on its own indented line", () => {
  // A root type long enough to exceed the inline budget pushes the labeled
  // schema onto a heading plus a multiline body, whose scalar-root branch
  // emits a single indented type line.
  const longType =
    '"alpha" | "bravo" | "charlie" | "delta" | "echo" | "foxtrot" | "golf"';
  const node: StructureNode = {
    kind: "schema",
    label: "schema",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 6,
    startOffset: 0,
    endOffset: 6,
    depth: 0,
    children: [],
    meta: {
      kind: "schema",
      schema: { rootType: longType, required: [], fields: [] },
    },
  };
  const doc: Document = {
    text: "schema\n",
    lines: [identLine("schema"), { text: "", spans: [] }],
    structure: [node],
    flatStructure: [node],
    definitions: new Map(),
  };
  const card = buildPeekCard(doc, node);
  const text = card.info.map((l) => l.text).join("\n");
  // A SCHEMA heading, then the scalar type on its own indented line.
  assert(text.includes("SCHEMA"), `multiline schema has a heading: ${text}`);
  const indented = card.info.find((l) =>
    l.text.startsWith("  ") && l.text.includes(longType)
  );
  assert(indented, `scalar root on its own indented line: ${text}`);
});

Deno.test("card: a wide nested-object field renders as a multiline block", () => {
  // A contract whose input schema has a nested object too wide to fit inline,
  // forcing schemaMultiline → fieldMultiline's nested-object expansion. The
  // contract has captures so it is treated as carrying its own schemas.
  const wide = "veryLongFieldNameThatPushesThisWellPastTheInlineBudget";
  const node: StructureNode = {
    kind: "builder",
    label: "lift wide",
    name: "wide",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 4,
    startOffset: 0,
    endOffset: 4,
    depth: 0,
    children: [],
    meta: {
      kind: "contract",
      builder: "lift",
      synthetic: false,
      captures: ["x"],
      innerBuilders: [],
      input: {
        rootType: "object",
        required: ["outer"],
        fields: [
          {
            name: "outer",
            type: "object",
            required: true,
            fields: [
              { name: wide, type: "string", required: true },
              { name: `${wide}2`, type: "number", required: false },
            ],
          },
        ],
      },
    },
  };
  const doc: Document = {
    text: "wide\n",
    lines: [identLine("wide"), { text: "", spans: [] }],
    structure: [node],
    flatStructure: [node],
    definitions: new Map(),
  };
  const card = buildPeekCard(doc, node);
  const text = card.info.map((l) => l.text).join("\n");
  // The nested object is opened on its own `{` line, with each field indented,
  // and a closing `}` — the multiline expansion rather than an inline `{ … }`.
  const lines = text.split("\n");
  const openIdx = lines.findIndex((l) =>
    l.trimEnd().endsWith("{") && l.includes("outer")
  );
  assert(openIdx >= 0, `nested object opens on its own line: ${text}`);
  assert(text.includes(wide), "renders the wide field name");
  assert(
    lines.some((l) => l.trim() === "}"),
    `has a closing brace line: ${text}`,
  );
});

Deno.test("card: an array-of-object field that exceeds the budget closes with }[]", () => {
  const wide = "anotherExtremelyLongPropertyNameForcingTheMultilineLayout";
  const node: StructureNode = {
    kind: "builder",
    label: "lift arr",
    name: "arr",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 3,
    startOffset: 0,
    endOffset: 3,
    depth: 0,
    children: [],
    meta: {
      kind: "contract",
      builder: "lift",
      synthetic: false,
      captures: ["x"],
      innerBuilders: [],
      input: {
        rootType: "object",
        required: ["rows"],
        fields: [
          {
            name: "rows",
            type: "object[]",
            required: true,
            fields: [
              { name: wide, type: "string", required: true },
              { name: `${wide}B`, type: "string", required: true },
            ],
          },
        ],
      },
    },
  };
  const doc: Document = {
    text: "arr\n",
    lines: [identLine("arr"), { text: "", spans: [] }],
    structure: [node],
    flatStructure: [node],
    definitions: new Map(),
  };
  const text = buildPeekCard(doc, node).info.map((l) => l.text).join("\n");
  // An array-of-object field closes the multiline block with `}[]`.
  assert(text.includes("}[]"), `array-of-object closes with }[]: ${text}`);
});

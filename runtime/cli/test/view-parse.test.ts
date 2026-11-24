import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import { parseDocument, SAMPLE, TS_PARSER_REGRESSION } from "./view-helpers.ts";
import { highlightDocument } from "../lib/view/languages/typescript/parse.ts";
import type { Document, TokenClass } from "../lib/view/model.ts";

// A blob exercising statement variety: a function with control flow and a
// return, a plain expression statement, a throw, a synthetic helper and its
// call, a pattern with a for-of loop and a return.
const RICH = `// transformed: /app.ts
function f(token) {
    if (token) {
        return { url: __cfLift_1({ token }) };
    }
    Object.freeze(f);
    throw new Error("x");
}
const __cfHardenFn = (h) => h;
__cfHardenFn(f);
export const p = pattern((input) => {
    const t = input.key("token");
    for (const k of t) {
        log(k);
    }
    return { url: t };
}, { type: "object" } as const satisfies __cfHelpers.JSONSchema);`;

function classesOf(doc: Document, token: string): Set<TokenClass> {
  const set = new Set<TokenClass>();
  for (const line of doc.lines) {
    for (const span of line.spans) {
      if (span.text === token) set.add(span.cls);
    }
  }
  return set;
}

Deno.test("parse: spans reconstruct every line verbatim", () => {
  const doc = parseDocument(SAMPLE);
  for (let i = 0; i < doc.lines.length; i++) {
    const recon = doc.lines[i].spans.map((s) => s.text).join("");
    assertEquals(recon, doc.lines[i].text, `line ${i}`);
  }
});

Deno.test("parse: whole document is byte-for-byte verbatim", () => {
  const doc = parseDocument(SAMPLE);
  const whole = doc.lines.map((l) => l.spans.map((s) => s.text).join("")).join(
    "\n",
  );
  assertEquals(whole, SAMPLE);
});

Deno.test("parse: classifies Common Fabric builders and synthetic helpers", () => {
  const doc = parseDocument(SAMPLE);
  assert(classesOf(doc, "lift").has("builderCall"), "lift is a builder");
  assert(classesOf(doc, "pattern").has("builderCall"), "pattern is a builder");
  assert(
    classesOf(doc, "__cfHelpers").has("cfHelper"),
    "__cfHelpers is a synthetic helper",
  );
  assert(
    classesOf(doc, "__cfLift_1").has("cfHelper"),
    "__cfLift_1 is a synthetic helper",
  );
});

Deno.test("parse: schema keys differ from ordinary identifiers", () => {
  const doc = parseDocument(SAMPLE);
  const typeClasses = classesOf(doc, "type");
  assert(typeClasses.has("schemaKey"), "schema key `type` is a schemaKey");
  assert(
    typeClasses.has("storageKeyword"),
    "`type Foo` keyword is a storage keyword",
  );
  assert(
    classesOf(doc, "properties").has("schemaKey"),
    "`properties` is a schemaKey",
  );
});

Deno.test("parse: type positions are colored as types", () => {
  const doc = parseDocument(SAMPLE);
  assert(classesOf(doc, "Foo").has("typeName"), "Foo type alias name");
  assert(classesOf(doc, "Bar").has("interfaceName"), "Bar interface name");
  assert(
    classesOf(doc, "JSONSchema").has("typeName"),
    "JSONSchema used in type position",
  );
  // `string`/`number` as type keywords
  assert(classesOf(doc, "string").has("typeKeyword"));
  assert(classesOf(doc, "number").has("typeKeyword"));
});

Deno.test("parse: strings, brackets and section headers", () => {
  const doc = parseDocument(SAMPLE);
  assert(classesOf(doc, '"object"').has("string"), "string literal");
  // bracket spans carry a depth
  let sawBracket = false;
  for (const line of doc.lines) {
    for (const span of line.spans) {
      if (span.cls === "bracket") {
        assert(span.bracketDepth !== undefined, "bracket has depth");
        sawBracket = true;
      }
    }
  }
  assert(sawBracket, "saw at least one bracket");
  // section header line is classified distinctly
  const headerLine = doc.lines.find((l) =>
    l.text.startsWith("// transformed: /index.ts")
  );
  assert(headerLine, "found header line");
  assertEquals(headerLine!.spans[0].cls, "sectionHeader");
});

Deno.test("parse: structure tree groups by section with builders and schemas", () => {
  const doc = parseDocument(SAMPLE);
  assertEquals(doc.structure.length, 2, "two sections");
  assertEquals(doc.structure[0].kind, "section");
  assert(doc.structure[0].label.includes("/index.ts"));
  assert(doc.structure[1].label.includes("/app.ts"));

  const flatLabels = doc.flatStructure.map((n) => `${n.kind}:${n.label}`);
  assert(
    flatLabels.some((l) => l.startsWith("pattern:pattern myPattern")),
    `expected a pattern node, got ${flatLabels.join(" | ")}`,
  );
  assert(
    flatLabels.some((l) => l.startsWith("builder:lift __cfLift_1")),
    "expected a lift builder node",
  );
  assert(
    flatLabels.some((l) => l.startsWith("schema:")),
    "expected at least one schema node",
  );
  assert(
    flatLabels.some((l) => l.startsWith("closure:")),
    "expected at least one closure node",
  );
});

Deno.test("parse: tuple (prefixItems) schema fields render as tuple types", () => {
  // CT-1895: tuples used to summarize as bare "array"
  const doc = parseDocument(`// transformed: /app.ts
const __cfLift_1 = lift({
    type: "object",
    properties: {
        pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
        rest: { type: "array", prefixItems: [{ type: "string" }], items: { type: "boolean" } }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, ({ pair }) => pair);
`);
  const schemaNode = doc.flatStructure.find((n) => n.meta?.kind === "schema");
  assert(schemaNode, "found a schema-meta node");
  const schema = (schemaNode!.meta as {
    kind: "schema";
    schema: { fields: readonly { name: string; type: string }[] };
  }).schema;
  const pair = schema.fields.find((f) => f.name === "pair");
  assertEquals(pair?.type, "[string, number, ...unknown[]]");
  const rest = schema.fields.find((f) => f.name === "rest");
  assertEquals(rest?.type, "[string, ...boolean[]]");
});

Deno.test("parse: closed tuples (items: false) and non-object slots", () => {
  const doc = parseDocument(`// transformed: /app.ts
const __cfLift_1 = lift({
    type: "object",
    properties: {
        closed: { type: "array", prefixItems: [{ type: "string" }], items: false },
        loose: { type: "array", prefixItems: [true] }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, ({ closed }) => closed);
`);
  const schemaNode = doc.flatStructure.find((n) => n.meta?.kind === "schema");
  assert(schemaNode, "found a schema-meta node");
  const schema = (schemaNode!.meta as {
    kind: "schema";
    schema: { fields: readonly { name: string; type: string }[] };
  }).schema;
  // items: false closes the tuple — no ...unknown[] tail.
  const closed = schema.fields.find((f) => f.name === "closed");
  assertEquals(closed?.type, "[string]");
  // A non-object-literal slot renders as "any"; the tail stays open.
  const loose = schema.fields.find((f) => f.name === "loose");
  assertEquals(loose?.type, "[any, ...unknown[]]");
});

Deno.test("parse: definition index resolves declarations", () => {
  const doc = parseDocument(SAMPLE);
  assert(doc.definitions.has("myPattern"), "myPattern defined");
  assert(doc.definitions.has("__cfLift_1"), "__cfLift_1 defined");
  assert(doc.definitions.has("Foo"), "Foo defined");
  assert(doc.definitions.has("Bar"), "Bar defined");
  const foo = doc.definitions.get("Foo")![0];
  assertEquals(foo.kind, "typeAlias");
  assert(foo.endLine > foo.startLine, "Foo spans multiple lines");
});

Deno.test("parse: no two structure nodes share the same source range", () => {
  for (const src of [SAMPLE, RICH]) {
    const doc = parseDocument(src);
    const seen = new Set<string>();
    for (const n of doc.flatStructure) {
      const key = `${n.startOffset}:${n.endOffset}`;
      assert(
        !seen.has(key),
        `two nodes cover [${n.startOffset}, ${n.endOffset}) — "${n.label}"`,
      );
      seen.add(key);
    }
  }
});

Deno.test("parse: every statement is reachable as a node at its own range", () => {
  const doc = parseDocument(RICH);
  const ranges = new Set(
    doc.flatStructure.map((n) => `${n.startOffset}:${n.endOffset}`),
  );
  const sf = ts.createSourceFile(
    "rich.ts",
    RICH,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // A statement is anything sitting in a statement list (a Block or the file).
  // Blocks themselves are transparent wrappers, so they are not expected nodes.
  const missing: string[] = [];
  const walk = (node: ts.Node) => {
    const parent = node.parent;
    const inStatementList = parent &&
      (ts.isBlock(parent) || ts.isSourceFile(parent)) &&
      (parent as ts.Block | ts.SourceFile).statements.some((s) => s === node);
    if (inStatementList && !ts.isBlock(node)) {
      const key = `${node.getStart(sf)}:${node.getEnd()}`;
      if (!ranges.has(key)) missing.push(node.getText(sf).split("\n")[0]);
    }
    node.forEachChild(walk);
  };
  walk(sf);
  assertEquals(missing, [], `unreachable statements: ${missing.join(" | ")}`);
});

Deno.test("parse: return and plain-expression statements are reachable", () => {
  const doc = parseDocument(RICH);
  const kinds = doc.flatStructure.map((n) => `${n.kind}:${n.label}`);
  assert(
    kinds.some((k) => k.startsWith("return:return { url }")),
    `expected a return node, got ${kinds.join(" | ")}`,
  );
  assert(
    kinds.some((k) => k.startsWith("control:if (token)")),
    "expected an if control node",
  );
  assert(
    kinds.some((k) => k.startsWith("control:for (… of …)")),
    "expected a for-of control node",
  );
  assert(
    kinds.some((k) => k.startsWith("statement:Object.freeze(f)")),
    "expected a plain expression statement node",
  );
  assert(
    kinds.some((k) => k.startsWith("statement:throw ")),
    "expected a throw statement node",
  );
});

Deno.test("parse: a variable node covers the whole statement", () => {
  const doc = parseDocument("const x = 1;\n");
  const x = doc.flatStructure.find((n) => n.name === "x")!;
  assertEquals(x.startCol, 0, "starts at the `const` keyword");
  // endCol lands after the closing `;` — the whole statement is the node.
  assertEquals(doc.lines[x.endLine].text.slice(0, x.endCol), "const x = 1;");
});

Deno.test("parse: JSX in a pattern stays one node (parsed as TSX)", () => {
  // Transformed pattern output keeps its JSX. In plain-TS mode `<cf-vstack>`
  // reads as a comparison and shreds the statement from the tag onward; as TSX
  // the whole `export default pattern(...)` is one node.
  const blob = `// transformed: /app.tsx
export default pattern((_) => {
    const x = input.key("x");
    return {
        [UI]: (<cf-vstack gap="3">
        {x && <p>none</p>}
      </cf-vstack>),
    };
}, { type: "object" } as const satisfies __cfHelpers.JSONSchema);`;
  const doc = parseDocument(blob);
  // Verbatim survives JSX.
  assertEquals(
    doc.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n"),
    blob,
  );
  // The whole export-default statement is one node, ending at the final `);`.
  const exp = doc.flatStructure.find((n) => n.kind === "export")!;
  assert(exp, "found the export-default node");
  assertEquals(exp.endLine, blob.split("\n").length - 1, "spans the statement");
  // The return covers the JSX (its closing tag), not truncated before it.
  const ret = doc.flatStructure.find((n) => n.kind === "return")!;
  const jsxClose = blob.split("\n").findIndex((l) =>
    l.includes("</cf-vstack>")
  );
  assert(ret && ret.endLine >= jsxClose, "return covers the JSX body");
  // No stray fragment leaked as its own statement (the .TS-mode artifact).
  assert(
    !doc.flatStructure.some((n) =>
      n.kind === "statement" && n.label.includes("cf-vstack")
    ),
    "no JSX fragment leaked as a statement node",
  );
});

Deno.test("parse: .ts files use the TypeScript parser", () => {
  const doc = parseDocument(TS_PARSER_REGRESSION, "fixture.ts");
  assert(
    doc.flatStructure.some((node) =>
      node.kind === "closure" && node.name === "identity"
    ),
    "the generic arrow function is parsed as TypeScript",
  );
  assert(
    classesOf(doc, "value").has("parameter"),
    "the generic arrow function parameter is classified",
  );
});

Deno.test("parse: a parser failure falls back to verbatim plain text", () => {
  const doc = parseDocument(TS_PARSER_REGRESSION, "fixture.tsx");
  assertEquals(doc.flatStructure, []);
  assertEquals(doc.definitions.size, 0);
  assertEquals(
    doc.lines.map((line) => line.text).join("\n"),
    TS_PARSER_REGRESSION,
  );
  for (const line of doc.lines) {
    assertEquals(
      line.spans,
      line.text.length === 0 ? [] : [{ col: 0, text: line.text, cls: "plain" }],
    );
  }
  assertEquals(
    highlightDocument(TS_PARSER_REGRESSION, "fixture.tsx"),
    doc.lines,
  );
});

Deno.test("parse: handles empty and whitespace-only input without throwing", () => {
  const empty = parseDocument("");
  assertEquals(empty.lines.length, 1);
  const ws = parseDocument("   \n\n  ");
  assertEquals(ws.lines.length, 3);
  for (const line of ws.lines) {
    assertEquals(line.spans.map((s) => s.text).join(""), line.text);
  }
});

//
// full-AST navigation
//

Deno.test("parse: the whole AST is navigable — RHS expression, chained calls, args", () => {
  const doc = parseDocument(
    `const main = make().name("x").run(1, 2);\n`,
    "m.ts",
  );
  const flat = doc.flatStructure;
  // The initializer (right side of =) is its own navigable node.
  const rhs = flat.find((n) =>
    n.kind === "node" && (n.astKinds?.includes("CallExpression") ?? false) &&
    n.label === ".run(…)"
  );
  assert(rhs, "the call chain is a node, labeled by its outermost method");
  // Chained calls are distinct nodes, each labeled by its own method.
  assert(flat.some((n) => n.label === ".name(…)"), "chained .name() is a node");
  assert(flat.some((n) => n.label === "make(…)"), "the base call is a node");
  // Their arguments are nodes too.
  assert(
    flat.some((n) => n.astKinds?.includes("StringLiteral")),
    "a string argument is navigable",
  );
  assert(
    flat.filter((n) => n.astKinds?.includes("NumericLiteral")).length >= 2,
    "the numeric arguments are navigable",
  );
});

Deno.test("highlight: a JSDoc {@link} tag stays one comment, not split into code", () => {
  const text = `/**
 * Builds a pager {@link Document} from a unified diff, plus more text after
 * the link, and a second line.
 */
const x = 1;
`;
  const lines = highlightDocument(text, "m.ts");
  // Lines 0–3 are the whole comment. Every span is a doc comment: the
  // {@link Document} reference is not torn out as an identifier, and the text
  // after it (and the following lines) is not left uncolored.
  for (let i = 0; i <= 3; i++) {
    for (const s of lines[i].spans) {
      assertEquals(
        s.cls,
        "docComment",
        `line ${i} span ${JSON.stringify(s.text)} should be docComment`,
      );
    }
  }
});

Deno.test("parse: comments are navigable nodes placed by source position", () => {
  const doc = parseDocument(`const a = 1;\n// a note\nconst b = 2;\n`, "m.ts");
  const comment = doc.flatStructure.find((n) => n.kind === "comment");
  assert(comment, "the comment is a structure node");
  assertEquals(comment!.label, "// a note");
  assertEquals(comment!.startLine, 1);
});

Deno.test("parse: a mid-chain comment is collected and navigable", () => {
  // A comment before a `.` is leading trivia of a punctuation token.
  const doc = parseDocument(`const x = a()\n  // step\n  .b();\n`, "m.ts");
  assert(
    doc.flatStructure.some((n) =>
      n.kind === "comment" && n.label === "// step"
    ),
    "the comment between chained calls is navigable",
  );
});

Deno.test("parse: nodes sharing an exact range merge into one", () => {
  const doc = parseDocument(`const x = a as B;\n`, "m.ts");
  // In `a as B` the type `B` is a TypeReference wrapping an Identifier over the
  // exact same range, so the two AST kinds merge into one structure node.
  const merged = doc.flatStructure.find((n) => (n.astKinds?.length ?? 0) > 1);
  assert(merged, "an exact-range overlap is merged into one node");
  assert(
    merged!.astKinds!.length >= 2,
    `the merged node records every AST kind: ${merged!.astKinds}`,
  );
  assert(
    merged!.astKinds!.includes("TypeReference") &&
      merged!.astKinds!.includes("Identifier"),
    `the merged node records both kinds: ${merged!.astKinds}`,
  );
});

Deno.test("parse: recognized folds do not expand into raw AST children", () => {
  // A node classified as a recognized shape (import, schema, type alias,
  // interface) suppresses its children: the build descends only into the child
  // source nodes the classification chose (`recurseInto`), never into raw
  // `forEachChild` output. Each of these is a leaf in the structure tree.
  const cases: Array<{ src: string; kind: string }> = [
    { src: `import { Command, Other } from "x";\n`, kind: "import" },
    {
      src: `type Foo = {\n  a: number;\n  b: string;\n};\n`,
      kind: "typeAlias",
    },
    { src: `interface Bar {\n  x: number;\n}\n`, kind: "interface" },
    {
      src:
        `const s = { type: "object", properties: { token: { type: "string" } } } as const satisfies __cfHelpers.JSONSchema;\n`,
      kind: "schema",
    },
  ];
  for (const { src, kind } of cases) {
    const doc = parseDocument(src, "m.ts");
    const node = doc.flatStructure.find((n) => n.kind === kind);
    assert(node, `expected a ${kind} node for ${JSON.stringify(src)}`);
    assertEquals(
      node!.children.length,
      0,
      `${kind} should fold to a leaf, but expanded into ${
        node!.children.map((c) => c.label).join(", ")
      }`,
    );
  }
});

Deno.test("parse: a schema binding does not leak schema keys or type machinery", () => {
  // The over-expansion this guards against: descending into a folded schema
  // re-emitted every property key (`type:`, `properties:`) and the trailing
  // `as const satisfies __cfHelpers.JSONSchema` type position as navigable
  // nodes, polluting the structure tree.
  const doc = parseDocument(
    `const s = { type: "object", properties: { token: { type: "string" } } } as const satisfies __cfHelpers.JSONSchema;\n`,
    "m.ts",
  );
  assert(
    !doc.flatStructure.some((n) => n.label === "properties:"),
    "the schema fold should not emit a `properties:` node",
  );
  assert(
    !doc.flatStructure.some((n) => n.label.includes("JSONSchema")),
    "the schema fold should not emit the JSONSchema type position",
  );
});

Deno.test("parse: a return of a reactive call keeps the call as its own node", () => {
  // The statement still re-emits its primary expression as a node: the reactive
  // call inside a `return` is reachable, then descends into its arguments.
  const doc = parseDocument(
    `function f() {\n  return pattern((input) => input);\n}\n`,
    "m.ts",
  );
  const ret = doc.flatStructure.find((n) => n.kind === "return")!;
  assert(ret, "the return statement is a node");
  assert(
    ret.children.some((c) => c.kind === "pattern"),
    `the reactive call is a child of the return, got ${
      ret.children.map((c) => `${c.kind}:${c.label}`).join(", ")
    }`,
  );
});

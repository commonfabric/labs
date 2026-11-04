import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import {
  ancestorsOf,
  collectIdentUses,
  findDependencies,
  findReferences,
} from "../lib/view/references.ts";
import type {
  Document,
  Line,
  Span,
  StructureNode,
  TokenClass,
} from "../lib/view/model.ts";

/** Build one identifier-class span at a given column. */
function ident(
  col: number,
  text: string,
  cls: TokenClass = "identifier",
): Span {
  return { col, text, cls };
}

/** Assemble a synthetic Document from line texts plus per-line spans. */
function makeDoc(lines: { text: string; spans: Span[] }[]): Document {
  const text = lines.map((l) => l.text).join("\n");
  const modelLines: Line[] = lines.map((l) => ({
    text: l.text,
    spans: l.spans,
  }));
  return {
    text,
    lines: modelLines,
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}

/** A structure node with sensible, overridable defaults. */
function node(partial: Partial<StructureNode>): StructureNode {
  return {
    kind: "closure",
    label: "synthetic",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 1000,
    startOffset: 0,
    endOffset: 1000,
    depth: 0,
    children: [],
    ...partial,
  };
}

Deno.test("findReferences: declaration plus call site, with inside flag", () => {
  const doc = parseDocument(SAMPLE);
  const lift = doc.flatStructure.find((n) => n.label === "lift __cfLift_1")!;
  const refs = findReferences(doc, "__cfLift_1", lift);
  assert(refs.length >= 2, `expected ≥2 occurrences, got ${refs.length}`);
  // the declaration is inside the lift node's range
  assert(refs.some((r) => r.inside), "declaration occurrence flagged inside");
  // the call site is outside (inside myPattern)
  const outside = refs.filter((r) => !r.inside);
  assert(outside.length >= 1, "a call site outside the declaration");
  assert(
    outside.some((r) => r.lineText.includes("__cfLift_1({")),
    "call-site context captured",
  );
});

Deno.test("findReferences: inside flag honors column bounds on boundary lines", () => {
  // One line, two occurrences of `foo`. The node covers only the second one
  // (columns 6..9); the first, at column 0, is a sibling to its left. With only
  // line bounds it is wrongly flagged inside, so it would vanish from the "uses"
  // list (and could be picked as the declaration).
  const doc = makeDoc([
    { text: "foo = foo", spans: [ident(0, "foo"), ident(6, "foo")] },
  ]);
  const within = node({
    name: "x",
    startLine: 0,
    endLine: 0,
    startCol: 6,
    endCol: 9,
  });
  const refs = findReferences(doc, "foo", within);
  assertEquals(refs.map((r) => [r.col, r.inside]), [[0, false], [6, true]]);

  // The same applies across boundary lines: a use to the left of startCol on
  // the start line, and one at/after endCol on the end line, are both outside.
  const multi = makeDoc([
    { text: "bar  bar", spans: [ident(0, "bar"), ident(5, "bar")] },
    { text: "bar  bar", spans: [ident(0, "bar"), ident(5, "bar")] },
  ]);
  const node2 = node({
    name: "y",
    startLine: 0,
    endLine: 1,
    startCol: 5,
    endCol: 5,
  });
  const got = findReferences(multi, "bar", node2).map((r) => [
    r.line,
    r.col,
    r.inside,
  ]);
  assertEquals(got, [
    [0, 0, false], // start line, left of startCol
    [0, 5, true], // start line, at startCol
    [1, 0, true], // end line, before endCol
    [1, 5, false], // end line, at endCol (exclusive)
  ]);
});

Deno.test("findReferences: ignores non-identifier occurrences", () => {
  const doc = parseDocument(SAMPLE);
  // "token" appears as a schema key (schemaKey) and as identifiers; references
  // should only pick identifier-role spans, not schema/property keys.
  const refs = findReferences(doc, "token");
  for (const r of refs) {
    assert(
      r.cls !== "schemaKey" && r.cls !== "propertyName",
      `unexpected key-role reference: ${r.cls}`,
    );
  }
});

Deno.test("findDependencies: pattern depends on the hoisted lift", () => {
  const doc = parseDocument(SAMPLE);
  const p = doc.flatStructure.find((n) => n.label === "pattern myPattern")!;
  const deps = findDependencies(doc, p);
  assert(
    deps.some((d) => d.name === "__cfLift_1"),
    `expected dependency on __cfLift_1, got ${deps.map((d) => d.name)}`,
  );
  const dep = deps.find((d) => d.name === "__cfLift_1")!;
  assertEquals(dep.kind, "builder");
});

Deno.test("findDependencies: excludes the node's own declarations", () => {
  const doc = parseDocument(SAMPLE);
  const p = doc.flatStructure.find((n) => n.label === "pattern myPattern")!;
  const deps = findDependencies(doc, p);
  // `t` and `url` are declared inside the pattern, not dependencies.
  assert(!deps.some((d) => d.name === "t"), "local binding t is not a dep");
});

Deno.test("findDependencies: member calls do not match same-named declarations", () => {
  for (const name of ["run", "render", "__cfLift_1"]) {
    const doc = parseDocument(`function ${name}() {}
worker.${name}();`);
    const statement = doc.flatStructure.find((node) =>
      node.startLine === 1 &&
      (node.kind === "statement" || node.kind === "builder")
    )!;
    assertEquals(findDependencies(doc, statement), [], name);
  }
});

Deno.test("collectIdentUses: a called member can match the selected binding's name", () => {
  const doc = parseDocument("const run = worker.run();");
  const binding = doc.flatStructure.find((node) => node.name === "run")!;
  const uses = collectIdentUses(doc, binding);
  assert(
    uses.some((use) =>
      use.name === "run" && use.useOffset === doc.text.lastIndexOf("run")
    ),
    "the called member remains available for an exact-position lookup",
  );
  assert(
    !uses.some((use) => use.useOffset === binding.nameOffset),
    "the binding declaration is not a use",
  );
});

Deno.test("ancestorsOf: chain from section down to the parent", () => {
  const doc = parseDocument(SAMPLE);
  const closure = doc.flatStructure.find((n) =>
    n.kind === "closure" && n.depth >= 2
  )!;
  const chain = ancestorsOf(doc.flatStructure, closure);
  assert(chain.length >= 1, "has ancestors");
  // ordered outermost → innermost, strictly increasing depth
  for (let i = 1; i < chain.length; i++) {
    assert(
      chain[i].depth > chain[i - 1].depth,
      "depth increases down the chain",
    );
  }
  // first ancestor is a section, last is shallower than the node
  assertEquals(chain[0].kind, "section");
  assert(chain[chain.length - 1].depth < closure.depth);
});

Deno.test("ancestorsOf: a root node has no ancestors", () => {
  const doc = parseDocument(SAMPLE);
  const section = doc.flatStructure.find((n) => n.kind === "section")!;
  assertEquals(ancestorsOf(doc.flatStructure, section).length, 0);
});

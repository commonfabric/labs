import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import {
  ancestorsOf,
  collectIdentUses,
  collectIdentUsesBounded,
  findDependencies,
} from "../lib/view/references.ts";
import type {
  Definition,
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
function makeDoc(
  lines: { text: string; spans: Span[]; bg?: Line["bg"] }[],
  definitions: Map<string, Definition[]> = new Map(),
): Document {
  const text = lines.map((l) => l.text).join("\n");
  const modelLines: Line[] = lines.map((l) => ({
    text: l.text,
    spans: l.spans,
    bg: l.bg,
  }));
  return {
    text,
    lines: modelLines,
    structure: [],
    flatStructure: [],
    definitions,
  };
}

/** A node spanning lines but reaching past the end of the document body. */
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

Deno.test("findDependencies: skips line indices past the end of the document", () => {
  // The node's endLine points beyond the available rows, so the loop body must
  // hit the missing-row guard and keep going rather than reading `undefined`.
  const dep: Definition = {
    name: "helper",
    kind: "function",
    startLine: 0,
    endLine: 0,
    startOffset: 0,
    endOffset: 6,
    // declaration lives outside the node's own offset range
  };
  const defs = new Map<string, Definition[]>([["helper", [dep]]]);
  const doc = makeDoc([
    { text: "useThing();", spans: [ident(0, "useThing", "callName")] },
  ], defs);

  const n = node({
    name: "outer",
    startLine: 0,
    // endLine deliberately exceeds the single existing line (index 0)
    endLine: 4,
    startOffset: 100,
    endOffset: 200,
  });

  const deps = findDependencies(doc, n);
  // No exception thrown; the present line has no external dependency match.
  assertEquals(deps, []);
});

Deno.test("findDependencies: real document still resolves a cross-node dep", () => {
  // Sanity check that the synthetic-doc path above did not change normal
  // behavior: the pattern still depends on the hoisted lift.
  const doc = parseDocument(SAMPLE);
  const p = doc.flatStructure.find((n) => n.label === "pattern myPattern")!;
  const deps = findDependencies(doc, p);
  assert(deps.some((d) => d.name === "__cfLift_1"));
});

Deno.test("findDependencies: removed diff lines do not contribute dependencies", () => {
  const dep: Definition = {
    name: "helper",
    kind: "function",
    startLine: 0,
    endLine: 0,
    startOffset: 0,
    endOffset: 6,
  };
  const doc = makeDoc(
    [{
      text: "helper",
      spans: [ident(0, "helper", "callName")],
      bg: "del",
    }],
    new Map([["helper", [dep]]]),
  );
  const n = node({ startOffset: 100, endOffset: 200 });
  assertEquals(findDependencies(doc, n), []);
});

Deno.test("collectIdentUses: skips line indices past the end of the document", () => {
  const doc = makeDoc([
    { text: "alpha beta", spans: [ident(0, "alpha"), ident(6, "beta")] },
  ]);
  const n = node({
    name: "outer",
    startLine: 0,
    // endLine exceeds the single existing row, exercising the missing-row guard
    endLine: 3,
    endCol: 1000,
  });

  const uses = collectIdentUses(doc, n);
  // Both identifiers on the present line are collected; the missing rows are
  // skipped without error.
  assertEquals(uses.map((u) => u.name), ["alpha", "beta"]);
});

Deno.test("collectIdentUses: removed diff lines do not consume the result limit", () => {
  const doc = makeDoc([
    { text: "old", spans: [ident(0, "old")], bg: "del" },
    { text: "live", spans: [ident(0, "live")] },
  ]);
  const n = node({ endLine: 1 });
  assertEquals(collectIdentUsesBounded(doc, n, 1), {
    uses: [{ name: "live", useOffset: 4 }],
    total: 1,
  });
});

Deno.test("collectIdentUses: a bounded collection counts omitted exact uses", () => {
  const doc = makeDoc([{
    text: "runrunrun",
    spans: [
      { ...ident(0, "run"), exactDefinitionName: "run" },
      { ...ident(3, "run"), exactDefinitionName: "run" },
      { ...ident(6, "run"), exactDefinitionName: "run" },
    ],
  }]);
  const n = node({});
  assertEquals(collectIdentUsesBounded(doc, n, 2), {
    uses: [
      {
        name: "run",
        displayName: "run",
        useOffset: 0,
        exactDefinitionOnly: true,
      },
      {
        name: "run",
        displayName: "run",
        useOffset: 3,
        exactDefinitionOnly: true,
      },
    ],
    total: 3,
  });
});

Deno.test("collectIdentUses: drops end-line spans at or past endCol", () => {
  // endLine == startLine here; the second span sits at col 6, and endCol is 5,
  // so the end-of-node column guard must exclude it.
  const doc = makeDoc([
    { text: "alpha beta", spans: [ident(0, "alpha"), ident(6, "beta")] },
  ]);
  const n = node({
    name: "outer",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 5,
  });

  const uses = collectIdentUses(doc, n);
  assertEquals(uses.map((u) => u.name), ["alpha"]);
});

Deno.test("collectIdentUses: keeps exact-position uses with equal spellings", () => {
  const doc = makeDoc([
    {
      text: "alpha alpha alpha",
      spans: [
        ident(0, "alpha"),
        { col: 5, text: " ", cls: "whitespace" },
        { ...ident(6, "alpha"), exactDefinitionName: "alpha" },
        { col: 11, text: " ", cls: "whitespace" },
        { ...ident(12, "alpha"), exactDefinitionName: "alpha" },
      ],
    },
  ]);
  const n = node({
    name: "outer",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 1000,
  });

  assertEquals(collectIdentUses(doc, n), [
    { name: "alpha", useOffset: 0 },
    {
      name: "alpha",
      displayName: "alpha",
      useOffset: 6,
      exactDefinitionOnly: true,
    },
    {
      name: "alpha",
      displayName: "alpha",
      useOffset: 12,
      exactDefinitionOnly: true,
    },
  ]);
});

Deno.test("ancestorsOf: a node absent from the flat list has no ancestors", () => {
  const doc = parseDocument(SAMPLE);
  // A freshly built node is not identity-equal to any element of flatStructure,
  // so indexOf returns -1 and the empty chain is returned.
  const stranger = node({ name: "stranger", depth: 3 });
  assert(!doc.flatStructure.includes(stranger));
  assertEquals(ancestorsOf(doc.flatStructure, stranger), []);
});

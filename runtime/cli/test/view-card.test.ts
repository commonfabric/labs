import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import { cpLen } from "../lib/view/ansi.ts";
import { buildPeekCard } from "../lib/view/card.ts";
import { findDependencies } from "../lib/view/references.ts";
import type { Document } from "../lib/view/model.ts";

function cardFor(doc: Document, label: string) {
  const node = doc.flatStructure.find((n) => n.label === label)!;
  const card = buildPeekCard(doc, node);
  return { node, card, text: card.info.map((l) => l.text).join("\n") };
}

Deno.test("card: lift shows contract, schema summary, outline and call site", () => {
  const doc = parseDocument(SAMPLE);
  const { card, text } = cardFor(doc, "lift __cfLift_1");
  assert(card.title.includes("lift __cfLift_1"));
  assert(
    text.includes("transformer-generated") && text.includes("lift helper"),
    "origin line marks the hoisted lift helper as transformer-generated",
  );
  assert(text.includes("captures") && text.includes("{ token }"), "captures");
  // schemas render as TypeScript-like types, not JSON-schema shapes
  assert(text.toLowerCase().includes("input"), "input section");
  assert(text.includes("{ token: string }"), "input rendered as a type");
  assert(text.toLowerCase().includes("output"), "output section");
  assert(!text.includes("· required:"), "no JSON-schema-style required note");
  assert(text.includes("OUTLINE"), "child outline");
  assert(text.includes("USES"), "uses section");
  assert(text.includes("__cfLift_1({"), "shows the call-site context");
});

Deno.test("card: origin line names transformer-generated nodes only", () => {
  const doc = parseDocument(SAMPLE);
  // A synthetic helper matches the transformer's vocabulary: it is named.
  const lift = cardFor(doc, "lift __cfLift_1").text;
  assert(lift.includes("transformer-generated"), "lift is named as generated");
  // A user pattern cannot be confirmed generated, so it gets no origin line.
  const pat = cardFor(doc, "pattern myPattern").text;
  assert(!pat.includes("origin"), "authored nodes get no origin claim");
  assert(
    !pat.includes("transformer-generated"),
    "and are not called generated",
  );
});

Deno.test("card: functions and closures show a type signature when annotated", () => {
  const doc = parseDocument(`// transformed: /app.ts
function __cfHardenFn(fn: Function): void {
    return;
}
const score = (e: Event, weight?: number): number => weight ?? 0;
const untyped = (a, b) => a + b;`);
  const fn = cardFor(doc, "ƒ __cfHardenFn").text;
  assert(fn.includes("signature"), "function has a signature line");
  assert(fn.includes("(fn: Function) → void"), `typed signature: ${fn}`);

  const score = cardFor(doc, "λ score").text;
  assert(
    score.includes("(e: Event, weight?: number) → number"),
    `closure signature with optional + return: ${score}`,
  );

  // An untyped closure carries no annotations, so it shows no signature line —
  // only the plainer parameter-name view.
  const untyped = cardFor(doc, "λ untyped").text;
  assert(!untyped.includes("signature"), "no signature without type info");
  assert(untyped.includes("params"), "still shows parameter names");
});

Deno.test("card: pattern shows captures→returns and dependencies", () => {
  const doc = parseDocument(SAMPLE);
  const { text } = cardFor(doc, "pattern myPattern");
  assert(text.includes("{ input }"), "captures");
  assert(text.includes("{ url }"), "return shape");
  assert(text.includes("DEPENDS ON"), "dependency section");
  assert(text.includes("__cfLift_1"), "names the dependency");
});

Deno.test("card: interface shows its members", () => {
  const doc = parseDocument(SAMPLE);
  const { text } = cardFor(doc, "interface Bar");
  assert(text.includes("MEMBERS") || text.includes("INTERFACE"));
  assert(text.includes("x") && text.includes("number"));
});

Deno.test("card: breadcrumb shows the enclosing path", () => {
  const doc = parseDocument(SAMPLE);
  const { text } = cardFor(doc, "lift __cfLift_1");
  assert(text.includes("path"), "has a breadcrumb line");
});

Deno.test("card: source is the verbatim node lines", () => {
  const doc = parseDocument(SAMPLE);
  const { node, card } = cardFor(doc, "pattern myPattern");
  const expected = doc.lines.slice(node.startLine, node.endLine + 1);
  assertEquals(card.source.length, expected.length);
  assertEquals(
    card.source.map((l) => l.text),
    expected.map((l) => l.text),
  );
});

Deno.test("card: info lines measure non-BMP glyphs as one display column", () => {
  // The kind glyph `𝑻` is a surrogate pair: its span must advance one column
  // so later spans on the line stay aligned with the cell renderer.
  const doc = parseDocument(SAMPLE);
  const { card } = cardFor(doc, "lift __cfLift_1");
  for (const line of card.info) {
    let col = 0;
    for (const span of line.spans) {
      assertEquals(
        span.col,
        col,
        `span col tracks code points in "${line.text}"`,
      );
      col += cpLen(span.text);
    }
  }
});

Deno.test("card: every info line reconstructs from its spans", () => {
  const doc = parseDocument(SAMPLE);
  const { card } = cardFor(doc, "lift __cfLift_1");
  for (const line of card.info) {
    assertEquals(line.spans.map((s) => s.text).join(""), line.text);
  }
});

Deno.test("card: targets reference real card lines and destinations", () => {
  const doc = parseDocument(SAMPLE);
  const { card } = cardFor(doc, "lift __cfLift_1");
  assert(card.targets.length > 0, "lift card has selectable targets");
  for (const t of card.targets) {
    // every target points at an existing card line and a real document line
    assert(t.cardLine >= 0 && t.cardLine < card.info.length, "cardLine valid");
    assert(t.destLine >= 0 && t.destLine < doc.lines.length, "destLine valid");
  }
  // a "use" target (no defOffset) points at the call-site line
  const use = card.targets.find((t) => t.defOffset === undefined);
  assert(use, "has a use target");
  assert(
    doc.lines[use!.destLine].text.includes("__cfLift_1("),
    "use target lands on the call site",
  );
});

Deno.test("card: dependency targets carry a definition offset", () => {
  const doc = parseDocument(SAMPLE);
  const { card } = cardFor(doc, "pattern myPattern");
  const dep = card.targets.find((t) => t.defOffset !== undefined);
  assert(dep, "pattern card has a dependency target");
  // the offset resolves to a real declaration node (__cfLift_1)
  const node = doc.flatStructure.find((n) => n.startOffset === dep!.defOffset);
  assert(node, "dependency offset resolves to a node");
});

// A lift with a nested-object input + an object output, plus a call site that
// has no schemas of its own.
const NESTED = `// transformed: /app.ts
const __cfLift_1 = __cfHelpers.lift<{
    page: { rows: { name: string }[] };
    pending: boolean;
}, { contacts: string[]; ok: boolean }>({
    type: "object",
    properties: {
        page: { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } }, required: ["rows"] },
        pending: { type: "boolean" }
    },
    required: ["page"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: { contacts: { type: "array", items: { type: "string" } }, ok: { type: "boolean" } },
    required: ["contacts", "ok"]
} as const satisfies __cfHelpers.JSONSchema, (a) => a);
export const test = pattern((__cf_pattern_input) => {
    const r = __cfLift_1({ page, pending }).for("r", true);
    return { contacts: r.key("contacts") };
}, { type: "object" } as const satisfies __cfHelpers.JSONSchema, { type: "object" } as const satisfies __cfHelpers.JSONSchema);`;

Deno.test("card: schemas render as TypeScript-like types", () => {
  const doc = parseDocument(NESTED);
  const lift = doc.flatStructure.find((n) =>
    n.kind === "builder" && n.name === "__cfLift_1"
  )!;
  const text = buildPeekCard(doc, lift).info.map((l) => l.text).join("\n");
  // nested object types, optional marker, array-of-object — not JSON shapes
  assert(text.includes("rows: { name: string }[]"), `nested type: ${text}`);
  // `pending` is not in `required`, so it is optional; `page` is required
  assert(text.includes("pending?: boolean"), "optional field marked with ?");
  assert(!text.includes("page?:"), "required field has no ?");
  // output fits inline
  assert(
    text.includes("{ contacts: string[]; ok: boolean }"),
    "inline output type",
  );
  assert(!text.includes('"object"') && !text.includes("· required:"));
});

const FETCH = `// transformed: /app.ts
export const test = pattern((__cf_pattern_input) => {
    const url = __cfLift_1({ token: 1 }).for("url", true);
    const page = fetchJson<{
        connections: { name: string }[];
    }>({
        url,
    }).for("page", true);
    return { ok: page.key("pending") };
}, { type: "object" } as const satisfies __cfHelpers.JSONSchema, { type: "object" } as const satisfies __cfHelpers.JSONSchema);`;

Deno.test("card: a builder call without schemas shows type args and arg keys", () => {
  const doc = parseDocument(FETCH);
  const fd = doc.flatStructure.find((n) => n.label === "fetchJson")!;
  assert(fd, "found the fetchJson node");
  const meta = fd.meta;
  assert(meta?.kind === "contract");
  if (meta?.kind === "contract") {
    // the self-reference bug is gone
    assertEquals(meta.innerBuilders.includes("fetchJson"), false);
  }
  const text = buildPeekCard(doc, fd).info.map((l) => l.text).join("\n");
  assert(!text.includes("fetchJson\ncalls  fetchJson"), "no self-call line");
  assert(!/calls .*fetchJson/.test(text), "fetchJson is not 'calling itself'");
  assert(text.includes("type args"), "shows type arguments");
  assert(
    text.includes("{ connections: { name: string }[] }"),
    "type argument rendered as a type",
  );
  assert(text.includes("args  { url }"), "shows the argument keys");
});

Deno.test("card: dependencies stay within the node's own span", () => {
  const doc = parseDocument(FETCH);
  const fd = doc.flatStructure.find((n) => n.label === "fetchJson")!;
  const deps = findDependencies(doc, fd);
  // `url` (a shorthand reference inside the call) is a real dependency...
  assert(deps.some((d) => d.name === "url"), "url is a dependency");
  // ...but `page`, the binding the call initializes on the same line, is not
  assert(!deps.some((d) => d.name === "page"), "page is not a dependency");
});

Deno.test("card: a lift with schemas does not also show redundant type args", () => {
  const doc = parseDocument(SAMPLE);
  const { text } = cardFor(doc, "lift __cfLift_1");
  assert(text.toLowerCase().includes("input"), "still shows input schema");
  assert(!text.includes("type args"), "no redundant type-args line");
});

Deno.test("card: a call site borrows its declaration's contract", () => {
  const doc = parseDocument(NESTED);
  // the call-site `__cfLift_1({...})` node has no schemas of its own
  const callSite = doc.flatStructure.find((n) =>
    n.kind === "builder" && n.label === "__cfLift_1" && !n.name
  )!;
  assert(callSite, "found the call-site node");
  const text = buildPeekCard(doc, callSite).info.map((l) => l.text).join("\n");
  assert(text.includes("from its declaration"), "notes the borrow");
  assert(text.includes("contacts: string[]"), "shows the resolved output type");
  assert(text.includes("rows: { name: string }[]"), "shows the resolved input");
});

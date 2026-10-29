import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import type { Document, StructureNode } from "../lib/view/model.ts";

function byLabel(doc: Document, label: string): StructureNode {
  const node = doc.flatStructure.find((n) => n.label === label);
  if (!node) throw new Error(`no node labeled "${label}"`);
  return node;
}

Deno.test("meta: lift contract — captures, input/output schema, synthetic", () => {
  const doc = parseDocument(SAMPLE);
  const lift = byLabel(doc, "lift __cfLift_1");
  assert(lift.meta?.kind === "contract", "lift has contract meta");
  if (lift.meta?.kind !== "contract") return;
  assertEquals(lift.meta.builder, "lift");
  assert(lift.meta.synthetic, "__cfLift_1 is synthetic");
  assertEquals(lift.meta.captures, ["token"]);
  assertEquals(lift.meta.input?.rootType, "object");
  assertEquals(lift.meta.input?.required, ["token"]);
  assertEquals(lift.meta.input?.fields[0]?.name, "token");
  assertEquals(lift.meta.input?.fields[0]?.type, "string");
  assertEquals(lift.meta.input?.fields[0]?.required, true);
  assertEquals(lift.meta.output?.rootType, "string");
});

Deno.test("meta: pattern contract — captures and return shape", () => {
  const doc = parseDocument(SAMPLE);
  const p = byLabel(doc, "pattern myPattern");
  assert(p.meta?.kind === "contract");
  if (p.meta?.kind !== "contract") return;
  assertEquals(p.meta.builder, "pattern");
  assertEquals(p.meta.synthetic, false);
  assertEquals(p.meta.captures, ["input"]);
  assertEquals(p.meta.returns, ["url"]);
});

Deno.test("meta: schema node — root type, required, fields", () => {
  const doc = parseDocument(SAMPLE);
  const schema = doc.flatStructure.find((n) =>
    n.kind === "schema" && n.meta?.kind === "schema" &&
    n.meta.schema.fields.some((f) => f.name === "token")
  );
  assert(schema, "found a token schema");
  if (schema?.meta?.kind !== "schema") return;
  assertEquals(schema.meta.schema.rootType, "object");
  assertEquals(schema.meta.schema.required, ["token"]);
});

Deno.test("meta: interface and type alias members", () => {
  const doc = parseDocument(SAMPLE);
  const foo = byLabel(doc, "type Foo");
  assert(foo.meta?.kind === "type");
  if (foo.meta?.kind === "type") {
    assertEquals(foo.meta.form, "alias");
    assertEquals(foo.meta.members.map((m) => m.name), ["a", "b"]);
    assertEquals(foo.meta.members.map((m) => m.type), ["number", "string"]);
  }
  const bar = byLabel(doc, "interface Bar");
  assert(bar.meta?.kind === "type");
  if (bar.meta?.kind === "type") {
    assertEquals(bar.meta.form, "interface");
    assertEquals(bar.meta.members[0]?.name, "x");
  }
});

Deno.test("meta: import names and module", () => {
  const doc = parseDocument(SAMPLE);
  const imp = doc.flatStructure.find((n) =>
    n.kind === "import" && n.meta?.kind === "import" &&
    n.meta.names.includes("pattern")
  );
  assert(imp, "found the pattern/lift import");
  if (imp?.meta?.kind !== "import") return;
  assertEquals(imp.meta.module, "commonfabric");
  assertEquals(imp.meta.names, ["pattern", "lift"]);
});

Deno.test("meta: closure params and variable binding", () => {
  const doc = parseDocument(SAMPLE);
  const closure = doc.flatStructure.find((n) =>
    n.kind === "closure" && n.meta?.kind === "closure" &&
    n.meta.params.includes("token")
  );
  assert(closure, "found the ({ token }) closure");

  const t = doc.flatStructure.find((n) => n.name === "t");
  assert(t?.meta?.kind === "variable", "binding t has variable meta");
  if (t?.meta?.kind === "variable") {
    assert(t.meta.bindsTo.includes("key"), "t binds to a .key() access");
  }
});

Deno.test("meta: variable type from annotation, cast, new, and literals", () => {
  const doc = parseDocument(`// transformed: /a.ts
const n = 42;
const s = "hi";
const d = new Date();
const m = new Map<string, number>();
const cfg = loadConfig() as AppConfig;
const ann: Foo<number> = bar();
const call = input.key("token");`);
  const typeOf = (name: string) => {
    const n = doc.flatStructure.find((x) => x.name === name);
    return n?.meta?.kind === "variable" ? n.meta.typeText : undefined;
  };
  assertEquals(typeOf("n"), "number", "numeric literal");
  assertEquals(typeOf("s"), "string", "string literal");
  assertEquals(typeOf("d"), "Date", "constructor");
  assertEquals(
    typeOf("m"),
    "Map<string, number>",
    "constructor with type args",
  );
  assertEquals(typeOf("cfg"), "AppConfig", "as-cast type");
  assertEquals(typeOf("ann"), "Foo<number>", "explicit annotation wins");
  // A plain call result cannot be typed without a checker, so we say nothing.
  assertEquals(typeOf("call"), undefined, "no type for an unknowable call");
});

Deno.test("meta: extraction never throws on odd input", () => {
  // truncated / malformed schema-ish input should not crash the parser
  const weird = `const x = lift({ type: } as const satisfies JSONSchema);
interface Empty {}
type U = A | B | C;
import "side-effect";`;
  const doc = parseDocument(weird);
  assert(doc.flatStructure.length >= 0);
});

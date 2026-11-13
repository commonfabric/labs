//! One refused and one accepted snippet for each diagnostic the front end
//! implements.
//!
//! In a refused snippet, `/*!*/` stands just before the node the diagnostic
//! is reported at.

use pattern_compiler::catalog::{Status, CATALOG};
use pattern_compiler::diagnostics::{Diagnostic, Severity};
use pattern_compiler::program::{analyze, SourceFile};

const PRELUDE: &str = "import { action, Cell, computed, eventKey, fetchJson, generateText, \
handler, grantSpaceAccess, ifElse, lift, llm, pattern, patternTool, SELF, sqliteDatabase, table, Writable, \
type Confidential, type Default, type PatternFactory, type PerUser, type Reactive, type WriteAuthorizedBy } from \"commonfabric\";\n";
const MARKER: &str = "/*!*/";

struct Case {
    id: &'static str,
    refused: &'static str,
    accepted: &'static str,
}

const fn case(id: &'static str, refused: &'static str, accepted: &'static str) -> Case {
    Case {
        id,
        refused,
        accepted,
    }
}

const CASES: &[Case] = &[
    case(
        "module-scope:let-declaration",
        "/*!*/let count = 0;",
        "const count = 0;",
    ),
    case(
        "module-scope:var-declaration",
        "/*!*/var count = 0;",
        "const count = 0;",
    ),
    case(
        "module-scope:class-declaration",
        "/*!*/class Donut {}",
        "interface Donut { name: string }",
    ),
    case(
        "module-scope:statement",
        "/*!*/console.log(\"glazed\");",
        "const GLAZED = String(1);",
    ),
    case(
        "module-scope:frozen-data-type",
        "const TOOLS = { glaze: /*!*/() => 1 };",
        "const glaze = () => 1;",
    ),
    case(
        "module-scope:frozen-data-write",
        "const GLAZES = [\"plain\"];\nfunction add() { /*!*/GLAZES.push(\"sugar\"); }",
        "const GLAZES = [\"plain\"];\nfunction add() { const copy = [...GLAZES]; copy.push(\"sugar\"); return copy; }",
    ),
    case(
        "module-scope:stateful-regexp",
        "const SPRINKLES = /*!*//sprinkle/g;",
        "const SPRINKLES = /sprinkle/;",
    ),
    case(
        "module-scope:import-form",
        "/*!*/import React from \"npm:react\";",
        "import { NAME } from \"commonfabric\";",
    ),
    case(
        "module-scope:runtime-call",
        "const QUOTE = /*!*/fetchJson({ url: \"https://donuts.example\" });",
        "const Quote = pattern(() => fetchJson({ url: \"https://donuts.example\" }));",
    ),
    case(
        "builder-callback:indirect-reference",
        "import { save } from \"./elsewhere.ts\";\nconst saveDonut = handler(/*!*/save);",
        "const save = (_event: unknown, _state: unknown) => {};\nconst saveDonut = handler(save);",
    ),
    case(
        "cell-factory:empty-array",
        "const Box = pattern(() => { const donuts = /*!*/new Writable([]); return { donuts }; });",
        "const Box = pattern(() => { const donuts = new Writable<string[]>([]); return { donuts }; });",
    ),
    case(
        "pattern-context:let-declaration",
        "const Box = pattern(() => { /*!*/let count = 1; return { count }; });",
        "const Box = pattern(() => { const count = 1; return { count }; });",
    ),
    case(
        "pattern-context:var-declaration",
        "const Box = pattern(() => { /*!*/var count = 1; return { count }; });",
        "const Box = pattern(() => { const count = 1; return { count }; });",
    ),
    case(
        "pattern-context:assignment",
        "const Box = pattern<{ count: number }>(({ count }) => ({ next: /*!*/count++ }));",
        "const Box = pattern<{ count: number }>(({ count }) => ({ next: count + 1 }));",
    ),
    case(
        "pattern-context:loop",
        "const Box = pattern(() => { /*!*/for (const glaze of [\"plain\"]) {} return {}; });",
        "const Box = pattern(() => { const glazes = [\"plain\"].map((glaze) => glaze); return { glazes }; });",
    ),
    case(
        "pattern-context:early-return",
        "const Box = pattern<{ count: number }>(({ count }) => { /*!*/return { count }; const more = 1; });",
        "const Box = pattern<{ count: number }>(({ count }) => { const more = 1; return { count, more }; });",
    ),
    case(
        "pattern-context:missing-return",
        "const Box = pattern(() => { const count = 1; /*!*/return; });",
        "const Box = pattern(() => { const count = 1; return { count }; });",
    ),
    case(
        "pattern-context:control-flow",
        "const Box = pattern<{ count: number }>(({ count }) => { /*!*/if (count) {} return { count }; });",
        "const Box = pattern<{ count: number }>(({ count }) => { const label = count ? \"some\" : \"none\"; return { label }; });",
    ),
    case(
        "pattern-context:statement",
        "const Box = pattern<{ price: number }>(({ price }) => { /*!*/price.toFixed(2); return { price }; });",
        "const Box = pattern<{ price: Writable<number> }>(({ price }) => { computed(() => { price.set(2); }); return { price }; });",
    ),
    case(
        "pattern-context:function-creation",
        "const Box = pattern(() => { const glaze = /*!*/() => 1; return {}; });",
        "const glaze = () => 1;\nconst Box = pattern(() => { const glazed = glaze(); return { glazed }; });",
    ),
    case(
        "pattern-context:object-member",
        "const Box = pattern(() => ({ /*!*/get count() { return 1; } }));",
        "const Box = pattern(() => ({ count: 1 }));",
    ),
    case(
        "pattern-context:parameter-form",
        "const Box = pattern<{ glaze?: string }>(({ /*!*/glaze = \"plain\" }) => ({ glaze }));",
        "const Box = pattern<{ glaze: string }>(({ glaze }) => ({ glaze }));",
    ),
    case(
        "pattern-context:builder-placement",
        "const Box = pattern(() => { const save = /*!*/handler(() => {}); return { save }; });",
        "const Box = pattern(() => { const save = action(() => {}); return { save }; });",
    ),
    case(
        "pattern-context:callback-container",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ sorted: prices.toSorted(/*!*/(a, b) => a - b) }));",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ sorted: computed(() => prices.toSorted((a, b) => a - b)) }));",
    ),
    case(
        "reactive:unsupported-call",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ reversed: /*!*/prices.reverse() }));",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ reversed: prices.toReversed() }));",
    ),
    case(
        "reactive:unsupported-expression",
        "const Box = pattern<{ baked: number }>(({ baked }) => ({ date: /*!*/new Date(baked) }));",
        "const Box = pattern<{ baked: number }>(({ baked }) => ({ date: computed(() => new Date(baked).toISOString()) }));",
    ),
    case(
        "pattern-context:self-access",
        "const Box = pattern<{ child: { count: number } }>(({ child }) => ({ self: /*!*/child[SELF] }));",
        "const Box = pattern<{ count: number }>((input) => ({ self: input[SELF] }));",
    ),
    case(
        "ses-callback:callable-capture",
        "function render() { const glaze = () => 1; return <button onClick={/*!*/() => glaze()} />; }",
        "const glaze = () => 1;\nfunction render() { return <button onClick={() => glaze()} />; }",
    ),
    case(
        "removed-form:helper",
        "const Box = pattern<{ fresh: boolean }>(({ fresh }) => ({ label: /*!*/ifElse(fresh, \"fresh\", \"stale\") }));",
        "const Box = pattern<{ fresh: boolean }>(({ fresh }) => ({ label: fresh ? \"fresh\" : \"stale\" }));",
    ),
    case(
        "removed-form:helper-unsupported",
        "const Box = pattern<{ fresh: boolean }>(({ fresh }) => ({ label: /*!*/ifElse(fresh, \"fresh\") }));",
        "const Box = pattern<{ fresh: boolean }>(({ fresh }) => ({ label: fresh ? \"fresh\" : \"stale\" }));",
    ),
    case(
        "removed-form:pattern-tool",
        "const Search = pattern<{ flavor: string; donuts: string[] }>(({ flavor, donuts }) => donuts.filter((donut) => donut === flavor));\nconst Box = pattern<{ donuts: string[] }>(({ donuts }) => ({ tool: /*!*/patternTool(Search, { donuts }) }));",
        "const Box = pattern<{ donuts: string[] }>(({ donuts }) => ({ tool: pattern<{ flavor: string }>(({ flavor }) => donuts.filter((donut) => donut === flavor)) }));",
    ),
    case(
        "removed-form:builtin",
        "const Box = pattern<{ prompt: string }>(({ prompt }) => ({ text: /*!*/llm({ prompt }) }));",
        "const Box = pattern<{ prompt: string }>(({ prompt }) => ({ text: generateText({ prompt }) }));",
    ),
    case(
        "collection:callback-parameters",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ shares: prices.map(/*!*/(price, index, all) => price / all.length + index) }));",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ shares: prices.map((price) => price / prices.length) }));",
    ),
    case(
        "collection:reduce-callback",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ total: prices.reduce(/*!*/(sum, price) => { return sum + price; }, 0) }));",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ total: prices.reduce((sum, price) => sum + price, 0) }));",
    ),
    case(
        "collection:reduce-initial",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ total: /*!*/prices.reduce((sum, price) => sum + price) }));",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ total: prices.reduce((sum, price) => sum + price, 0) }));",
    ),
    case(
        "collection:index-keyed",
        "const Box = pattern<{ names: string[] }>(({ names }) => ({ rows: names.map(/*!*/(name, index) => `${index}. ${name}`) }));",
        "const Box = pattern<{ names: string[] }>(({ names }) => ({ rows: names.map((name) => `${name}!`) }));",
    ),
    case(
        "cell:unsupported-method",
        "const peek = handler<unknown, { count: Writable<number> }>((_, { count }) => { /*!*/count.getRaw(); });",
        "const peek = handler<unknown, { count: Writable<number> }>((_, { count }) => { count.get(); });",
    ),
    case(
        "cell:collection-method-in-function",
        "const list = handler<unknown, { donuts: Writable<string[]> }>((_, { donuts }) => { const names = /*!*/donuts.map((donut) => donut); console.log(names); });",
        "const list = handler<unknown, { donuts: Writable<string[]> }>((_, { donuts }) => { const names = donuts.get().map((donut) => donut); console.log(names); });",
    ),
    case(
        "cell:cause-not-literal",
        "const Box = pattern<{ id: string }>(({ id }) => { const count = /*!*/Writable.for<number>(id); return { count }; });",
        "const Box = pattern(() => { const count = Writable.for<number>(\"count\"); return { count }; });",
    ),
    case(
        "cell:method-tier",
        "const Box = pattern(() => { const count = new Writable(0); /*!*/count.set(1); return { count }; });",
        "const Box = pattern(() => { const count = new Writable(0); const bump = action(() => count.set(1)); return { count, bump }; });",
    ),
    case(
        "sqlite:tables-not-static",
        "const Box = pattern(() => { const db = sqliteDatabase({ tables: /*!*/[\"notes\"] }); return { db }; });",
        "const Box = pattern(() => { const db = sqliteDatabase({ tables: { notes: table({ id: \"text\" }) } }); return { db }; });",
    ),
    case(
        "collection:nested-scan",
        "const Box = pattern<{ donuts: { id: string }[]; orders: { id: string }[] }>(({ donuts, orders }) => ({ rows: donuts.map((donut) => /*!*/orders.find((order) => order.id === donut.id)) }));",
        "const Box = pattern<{ donuts: { id: string; toppings: string[] }[] }>(({ donuts }) => ({ rows: donuts.map((donut) => donut.toppings.map((topping) => topping)) }));",
    ),
    case(
        "function-body:async",
        "const load = /*!*/async () => 1;",
        "const load = () => 1;",
    ),
    case(
        "function-body:generator",
        "/*!*/function* glazes() { yield \"plain\"; }",
        "function glazes() { return [\"plain\"]; }",
    ),
    case(
        "function-body:class",
        "function make() { /*!*/class Donut {} return new Donut(); }",
        "function make() { return { name: \"plain\" }; }",
    ),
    case(
        "function-body:this",
        "function self() { return /*!*/this; }",
        "function self(donut: { name: string }) { return donut; }",
    ),
    case(
        "function-body:var",
        "function count() { /*!*/var total = 1; return total; }",
        "function count() { let total = 1; total += 1; return total; }",
    ),
    case(
        "function-body:for-in",
        "function keys(box: Record<string, number>) { const out: string[] = []; /*!*/for (const key in box) { out.push(key); } return out; }",
        "function keys(box: Record<string, number>) { const out: string[] = []; for (const key of Object.keys(box)) { out.push(key); } return out; }",
    ),
    case(
        "function-body:dynamic-code",
        "function stop() { /*!*/debugger; }",
        "function stop() { return; }",
    ),
    case(
        "function-body:accessor",
        "function make() { return { /*!*/get count() { return 1; } }; }",
        "function make() { return { count: () => 1 }; }",
    ),
    case(
        "function-body:unsupported-global",
        "function later() { return /*!*/Promise.resolve(1); }",
        "function later() { return 1; }",
    ),
    case(
        "function-body:global-write",
        "function leak() { /*!*/Math.glazed = 1; }",
        "function keep() { const box = { glazed: 0 }; box.glazed = 1; return box; }",
    ),
    case(
        "function-body:constructor",
        "function Donut() { return { name: \"plain\" }; }\nfunction make() { return /*!*/new Donut(); }",
        "function Donut() { return { name: \"plain\" }; }\nfunction make() { return Donut(); }",
    ),
    case(
        "function-body:ambient-read",
        "const stamp = lift((name: string) => `${name} ${/*!*/Date.now()}`);",
        "const stamp = handler<unknown, { at: Writable<number> }>((_, { at }) => { at.set(Date.now()); });",
    ),
    case(
        "function-body:builder-call",
        "const save = handler(() => { const total = /*!*/computed(() => 1); console.log(total); });",
        "const save = handler(() => { const more = action(() => {}); console.log(more); });",
    ),
    case(
        "function-body:handler-capture",
        "function render() { let count = 0; count += 1; return <button onClick={/*!*/() => console.log(count)} />; }",
        "function render() { let count = 0; count += 1; const shown = count; return <button onClick={() => console.log(shown)} />; }",
    ),
    case(
        "function-body:cell-needs-cause",
        "const make = lift((name: string) => { const box = /*!*/new Writable(name); return box; });",
        "const make = lift((name: string) => { const box = Writable.for<string>(name); return box; });",
    ),
    case(
        "function-body:effect-in-computation",
        "const quote = lift((url: string) => /*!*/fetchJson({ url }));",
        "const Quote = pattern<{ url: string }>(({ url }) => fetchJson({ url }));",
    ),
    case(
        "function-body:event-context-in-computation",
        "const key = lift((name: string) => name + /*!*/eventKey());",
        "const key = handler<unknown, { last: Writable<string> }>((_, { last }) => { last.set(eventKey()); });",
    ),
    case(
        "collection:shared-element-state",
        "const GLAZES = [\"plain\", \"glazed\"];\nconst Box = pattern(() => { const rows = GLAZES.map((glaze) => { const open = /*!*/new Writable(false); return <li onClick={() => open.set(!open.get())}>{glaze}</li>; }); return { rows }; });",
        "const GLAZES = [\"plain\", \"glazed\"];\nconst Box = pattern(() => { const rows = GLAZES.map((glaze, index) => { const open = new Writable(false); return <li onClick={() => open.set(!open.get())}>{index + 1}. {glaze}</li>; }); return { rows }; });",
    ),
    case(
        "verb-result:undeclared-return",
        "const save = handler(() => { /*!*/return { saved: true }; });",
        "const save = handler<unknown, unknown, { saved: boolean }>(() => { return { saved: true }; });",
    ),
    case(
        "computed:not-promoted",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ total: /*!*/computed(() => { let sum = 0; for (const price of prices) sum += price; return sum; }) }));",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ count: computed(() => prices.length) }));",
    ),
    case(
        "computed:redundant",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ count: /*!*/computed(() => prices.length) }));",
        "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ count: prices.length }));",
    ),
    case(
        "subset-type:conditional",
        "type Glaze<T> = /*!*/T extends string ? \"named\" : \"plain\";",
        "type Glaze = \"named\" | \"plain\";",
    ),
    case(
        "subset-type:mapped",
        "type Prices = /*!*/{ [K in \"plain\" | \"sugar\"]: number };",
        "type Prices = Record<\"plain\" | \"sugar\", number>;",
    ),
    case(
        "subset-type:template-literal",
        "type Sku = /*!*/`donut-${string}`;",
        "type Sku = string;",
    ),
    case(
        "subset-type:overload",
        "/*!*/function boxOf(box: unknown): Cell<string>;\nfunction boxOf(box: unknown): unknown { return box; }",
        "function boxOf(box: unknown): unknown { return box; }",
    ),
    case(
        "subset-type:class",
        "type Maker = /*!*/new () => object;",
        "type Maker = () => object;",
    ),
    case(
        "subset-type:callable-object",
        "interface Glazer { /*!*/(name: string): string }",
        "type Glazer = (name: string) => string;",
    ),
    case(
        "subset-type:assertion-signature",
        "function check(name: unknown): /*!*/asserts name is string { if (typeof name !== \"string\") throw new Error(\"no name\"); }",
        "function check(name: unknown): name is string { return typeof name === \"string\"; }",
    ),
    case(
        "subset-type:unsupported-modifier",
        "interface Sink</*!*/in T> { put: (value: T) => void }",
        "interface Sink<T> { put: (value: T) => void }",
    ),
    case(
        "subset-type:index-signature-key",
        "interface Tray { /*!*/[slot: number]: string }",
        "interface Tray { [slot: string]: string }",
    ),
    case(
        "subset-syntax:enum",
        "/*!*/enum Glaze { Plain }",
        "type Glaze = \"plain\";",
    ),
    case(
        "subset-syntax:namespace",
        "/*!*/namespace Bakery { export const open = true; }",
        "const open = true;",
    ),
    case(
        "subset-syntax:ambient-declaration",
        "/*!*/declare global { interface Bakery { open: boolean } }",
        "interface Bakery { open: boolean }",
    ),
    case(
        "subset-syntax:decorator",
        "function sealed(target: unknown) { return target; }\n/*!*/@sealed class Donut {}",
        "function sealed(target: unknown) { return target; }",
    ),
    case(
        "subset-type:non-regular-recursion",
        "type Nest<T> = { value: T; inner: /*!*/Nest<T[]> | null };",
        "type Tree<T> = { value: T; children: Tree<T>[] };",
    ),
    case(
        "subset-type:any",
        "const glaze: /*!*/any = 1;",
        "const glaze: unknown = 1;",
    ),
    case(
        "cast-validation:forbidden-cast",
        "const Box = pattern<{ count: number }>(({ count }) => ({ count: /*!*/count as Reactive<number> }));",
        "const Box = pattern<{ count: number }>(({ count }) => ({ count }));",
    ),
    case(
        "cast-validation:cell-cast",
        "function boxOf(box: unknown) { return /*!*/box as Writable<number>; }",
        "function boxOf(box: Writable<number>) { return box; }",
    ),
    case(
        "subset-type:function-in-data",
        "const Box = pattern</*!*/{ format: (name: string) => string }>(({ format }) => ({ format }));",
        "const Box = pattern<{ format: PatternFactory<{ name: string }, string> }>(({ format }) => ({ format }));",
    ),
    case(
        "subset-type:empty-intersection",
        "type Both = /*!*/string & number;",
        "type Both = { name: string } & { price: number };",
    ),
    case(
        "subset-type:operator-operand",
        "type Part = /*!*/Partial<string>;",
        "type Part = Partial<{ name: string }>;",
    ),
    case(
        "default:not-static",
        "interface Input { glaze: /*!*/Default<string, string> }",
        "interface Input { glaze: Default<string, \"plain\"> }",
    ),
    case(
        "scope:union-member",
        "interface Input { draft: /*!*/PerUser<string> | number }",
        "interface Input { draft: PerUser<string> | undefined }",
    ),
    case(
        "cfc-label:not-a-list",
        "type Secret = /*!*/Confidential<string, string[]>;",
        "type Secret = Confidential<string, readonly [\"recipe-secret\"]>;",
    ),
    case(
        "cfc-label:not-static",
        "type Secret = /*!*/Confidential<string, readonly [\"a\" | \"b\"]>;",
        "type Secret = Confidential<string, readonly [\"a\", \"b\"]>;",
    ),
    case(
        "cfc-write-authorized-by",
        "const RULES = [\"plain\"];\ntype Guarded = /*!*/WriteAuthorizedBy<string, typeof RULES>;",
        "const save = handler<unknown, { name: Writable<string> }>((_, { name }) => name.set(\"plain\"));\ntype Guarded = WriteAuthorizedBy<string, typeof save>;",
    ),
    case(
        "opaque-get:invalid-call",
        "const Box = pattern<{ donut: { name: string } }>(({ donut }) => ({ name: /*!*/donut.get().name }));",
        "const Box = pattern<{ donut: Writable<{ name: string }> }>(({ donut }) => ({ name: donut.get().name }));",
    ),
    case(
        "schema-type:symbol",
        "type Key = /*!*/symbol;",
        "type Key = string;",
    ),
    case(
        "stdlib:unsupported-member",
        "function root(volume: number) { return /*!*/Math.cbrt(volume); }",
        "function root(volume: number) { return Math.sqrt(volume); }",
    ),
];

fn check_program(files: &[(&str, &str)]) -> Vec<Diagnostic> {
    let files: Vec<SourceFile> = files
        .iter()
        .map(|(path, text)| SourceFile {
            path: path.to_string(),
            text: text.to_string(),
        })
        .collect();
    let analysis = analyze(&files);
    assert!(
        analysis.failures.is_empty(),
        "parse failure: {:?}",
        analysis.failures
    );
    analysis
        .modules
        .into_iter()
        .flat_map(|module| module.diagnostics)
        .collect()
}

fn check(snippet: &str) -> Vec<Diagnostic> {
    check_program(&[("case.tsx", &format!("{PRELUDE}{snippet}"))])
}

/// The line and column of the marker in `snippet` once the prelude is in
/// front of it, and the snippet without the marker.
fn marked(snippet: &str) -> ((u32, u32), String) {
    let offset = snippet
        .find(MARKER)
        .expect("a refused snippet has a marker");
    let before = format!("{PRELUDE}{}", &snippet[..offset]);
    let line = before.matches('\n').count() as u32 + 1;
    let column = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32 + 1;
    ((line, column), snippet.replace(MARKER, ""))
}

#[test]
fn every_implemented_diagnostic_refuses_its_snippet_at_the_marked_position() {
    for case in CASES {
        let (position, snippet) = marked(case.refused);
        let diagnostics = check(&snippet);
        let found = diagnostics.iter().any(|diagnostic| {
            diagnostic.id == case.id && (diagnostic.line, diagnostic.column) == position
        });
        assert!(
            found,
            "{} is not reported at {position:?} for:\n{snippet}\ngot: {:#?}",
            case.id,
            diagnostics
                .iter()
                .map(|diagnostic| (diagnostic.id, diagnostic.line, diagnostic.column))
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn every_implemented_diagnostic_accepts_its_neighboring_snippet() {
    for case in CASES {
        let diagnostics = check(case.accepted);
        let refused: Vec<_> = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.is_error() || diagnostic.id == case.id)
            .map(|diagnostic| diagnostic.to_string())
            .collect();
        assert!(
            refused.is_empty(),
            "the accepted snippet for {} is reported:\n{}\n{refused:#?}",
            case.id,
            case.accepted
        );
    }
}

#[test]
fn every_diagnostic_has_the_severity_of_the_catalog() {
    for case in CASES {
        let (_, snippet) = marked(case.refused);
        let entry = CATALOG.iter().find(|entry| entry.id == case.id).unwrap();
        for diagnostic in check(&snippet) {
            if diagnostic.id == case.id {
                assert_eq!(Some(diagnostic.severity), entry.severity, "{}", case.id);
            }
        }
    }
}

/// The diagnostics that need more than one module, which have tests of
/// their own below.
const PROGRAM_CASES: [&str; 4] = [
    "import:signature-not-in-subset",
    "import:not-a-function",
    "import:signature-not-data",
    "import:commonfabric-value",
];

#[test]
fn every_implemented_catalog_entry_has_a_case() {
    for entry in CATALOG {
        if !matches!(entry.status, Status::Implemented { .. }) {
            continue;
        }
        let covered =
            CASES.iter().any(|case| case.id == entry.id) || PROGRAM_CASES.contains(&entry.id);
        assert!(covered, "{} has no test case", entry.id);
    }
}

const MATH: &str = "\"use typescript\";\n\
export function unitPrice(basePrice: number, glaze: string): number { return basePrice + glaze.length; }\n\
export function loose(basePrice) { return basePrice; }\n\
export function withCell(price: Cell<number>): number { return price.get(); }\n\
export const TAX = 0.2;\n\
import type { Cell } from \"commonfabric\";\n";

fn ids(diagnostics: &[Diagnostic]) -> Vec<&'static str> {
    diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == Severity::Error)
        .map(|diagnostic| diagnostic.id)
        .collect()
}

#[test]
fn import_of_an_annotated_function_of_an_imported_module_is_accepted() {
    let user =
        "import { unitPrice } from \"./math.ts\";\nexport const price = unitPrice(2, \"plain\");\n";
    assert_eq!(
        ids(&check_program(&[("math.ts", MATH), ("user.ts", user)])),
        Vec::<&str>::new()
    );
}

#[test]
fn import_of_a_function_without_annotations_is_refused() {
    let user = "import { loose } from \"./math.ts\";\nexport const price = loose(2);\n";
    assert_eq!(
        ids(&check_program(&[("math.ts", MATH), ("user.ts", user)])),
        ["import:signature-not-in-subset"]
    );
}

#[test]
fn import_of_a_function_that_takes_a_cell_is_refused() {
    let user = "import { withCell } from \"./math.ts\";\nexport const price = withCell;\n";
    assert_eq!(
        ids(&check_program(&[("math.ts", MATH), ("user.ts", user)])),
        ["import:signature-not-data"]
    );
}

#[test]
fn import_of_a_constant_of_an_imported_module_is_refused() {
    let user = "import { TAX } from \"./math.ts\";\nexport const tax = TAX;\n";
    assert_eq!(
        ids(&check_program(&[("math.ts", MATH), ("user.ts", user)])),
        ["import:not-a-function"]
    );
}

#[test]
fn value_import_from_commonfabric_in_an_imported_module_is_refused() {
    let module = "\"use typescript\";\nimport { lift } from \"commonfabric\";\nexport const double = lift((n: number) => n * 2);\n";
    assert_eq!(
        ids(&check_program(&[("math.ts", module)])),
        ["import:commonfabric-value"]
    );
}

#[test]
fn computation_that_reads_the_clock_through_an_authored_function_is_refused() {
    let module = "function stamp() { return Date.now(); }\nconst at = lift((name: string) => name + stamp());\n";
    assert_eq!(ids(&check(module)), ["function-body:ambient-read"]);
    let handled = "function stamp() { return Date.now(); }\nconst at = handler<unknown, { at: Writable<number> }>((_, { at }) => { at.set(stamp()); });\n";
    assert_eq!(ids(&check(handled)), Vec::<&str>::new());
}

#[test]
fn local_binding_named_like_a_removed_helper_is_not_the_helper() {
    let module = "function choose(ifElse: (a: number) => number) { return ifElse(1); }\n";
    let diagnostics = check_program(&[("case.ts", module)]);
    assert_eq!(ids(&diagnostics), Vec::<&str>::new());
}

#[test]
fn builder_reached_through_an_alias_and_a_namespace_is_recognized() {
    let alias = "import { handler as on, pattern as view } from \"commonfabric\";\nexport const Box = view(() => { const save = on(() => {}); return { save }; });\n";
    assert_eq!(
        ids(&check_program(&[("case.ts", alias)])),
        ["pattern-context:builder-placement"]
    );
    let namespace = "import * as cf from \"commonfabric\";\nexport const Box = cf.pattern(() => { const save = cf.handler(() => {}); return { save }; });\n";
    assert_eq!(
        ids(&check_program(&[("case.ts", namespace)])),
        ["pattern-context:builder-placement"]
    );
}

#[test]
fn removed_helper_passed_as_a_value_is_refused() {
    let module = "const choose = [ifElse];\n";
    assert_eq!(ids(&check(module)), ["removed-form:helper-unsupported"]);
}

#[test]
fn row_label_rule_of_table_is_accepted_in_the_reactive_tier() {
    let module = "import { cfSqlite } from \"commonfabric\";\n\
        const Box = pattern(() => {\n\
          const db = sqliteDatabase({ tables: { notes: cfSqlite.table({ id: \"text\" }, (row) => ({ owner: row.id })) } });\n\
          return { db };\n\
        });\n";
    assert_eq!(ids(&check(module)), Vec::<&str>::new());
}

fn all(snippet: &str) -> Vec<&'static str> {
    check(snippet)
        .iter()
        .map(|diagnostic| diagnostic.id)
        .collect()
}

#[test]
fn reactive_block_without_a_return_is_refused() {
    let module = "const Box = pattern(() => { const count = 1; });\n";
    assert_eq!(ids(&check(module)), ["pattern-context:missing-return"]);
    let callback = "const Box = pattern<{ names: string[] }>(({ names }) => ({ rows: names.map((name) => { const upper = name.toUpperCase(); }) }));\n";
    assert_eq!(ids(&check(callback)), ["pattern-context:missing-return"]);
}

#[test]
fn staged_change_in_the_reactive_tier_is_an_effect_in_a_computation() {
    let module = "const Box = pattern<{ room: unknown }>(({ room }) => ({ done: grantSpaceAccess(room, \"did:key:a\", \"READ\") }));\n";
    assert_eq!(ids(&check(module)), ["function-body:effect-in-computation"]);
    let handled = "const grant = handler<unknown, { room: unknown }>((_, { room }) => { grantSpaceAccess(room, \"did:key:a\", \"READ\"); });\n";
    assert_eq!(ids(&check(handled)), Vec::<&str>::new());
}

#[test]
fn builder_written_inside_frozen_data_follows_its_kind() {
    let lifted = "const TOOLS = [lift((n: number) => n + 1)];\n";
    assert_eq!(ids(&check(lifted)), ["module-scope:frozen-data-type"]);
    let patterns = "const TOOLS = [pattern(() => ({ count: 1 })), handler(() => {})];\n";
    assert_eq!(ids(&check(patterns)), Vec::<&str>::new());
    let computed = "const TOTAL = computed(() => 1);\n";
    assert_eq!(ids(&check(computed)), ["module-scope:runtime-call"]);
}

#[test]
fn frozen_data_initializer_makes_no_runtime_call_through_a_function() {
    let module = "function box() { return new Writable(0); }\nconst BOX = box();\n";
    assert_eq!(ids(&check(module)), ["module-scope:runtime-call"]);
    let clock = "function stamp() { return Date.now(); }\nconst LOADED = stamp();\n";
    assert_eq!(ids(&check(clock)), ["function-body:ambient-read"]);
    let pure = "function double(n: number) { return n * 2; }\nconst FOUR = double(2);\n";
    assert_eq!(ids(&check(pure)), Vec::<&str>::new());
}

#[test]
fn object_prototype_is_legal_as_an_operand_of_a_comparison_only() {
    let test = "function plain(value: object) { return Object.getPrototypeOf(value) === Object.prototype; }\n";
    assert_eq!(ids(&check(test)), Vec::<&str>::new());
    let member = "function text(value: object) { return Object.prototype.toString.call(value); }\n";
    assert_eq!(ids(&check(member)), ["stdlib:unsupported-member"]);
}

#[test]
fn expression_statement_in_the_reactive_tier_is_reported_once() {
    let void = "const Box = pattern<{ count: number }>(({ count }) => { void count; return { count }; });\n";
    assert_eq!(ids(&check(void)), ["pattern-context:statement"]);
    let log = "const Box = pattern<{ count: number }>(({ count }) => { console.log(count); return { count }; });\n";
    assert_eq!(ids(&check(log)), ["pattern-context:statement"]);
}

#[test]
fn default_in_a_collection_callback_parameter_is_refused() {
    let module = "const Box = pattern<{ names: string[] }>(({ names }) => ({ rows: names.map((name = \"plain\") => name) }));\n";
    assert_eq!(ids(&check(module)), ["collection:callback-parameters"]);
    let pattern = "const Box = pattern<{ pairs: [string, number][] }>(({ pairs }) => ({ rows: pairs.map(([name, price]) => `${name} ${price}`) }));\n";
    assert_eq!(ids(&check(pattern)), Vec::<&str>::new());
}

#[test]
fn default_in_a_const_destructuring_needs_a_constant_initializer() {
    let module = "const Box = pattern<{ donut: { glaze?: string } }>(({ donut }) => { const { glaze = \"plain\" } = donut; return { glaze }; });\n";
    assert_eq!(ids(&check(module)), ["reactive:unsupported-expression"]);
    let constant = "const DONUT = { name: \"plain\" };\nconst Box = pattern(() => { const { name = \"none\", ...rest } = DONUT; return { name, rest }; });\n";
    assert_eq!(ids(&check(constant)), Vec::<&str>::new());
}

#[test]
fn object_literal_key_that_is_not_static_is_refused_in_the_reactive_tier() {
    let module = "const Box = pattern<{ key: string }>(({ key }) => ({ [key]: 1 }));\n";
    assert_eq!(ids(&check(module)), ["reactive:unsupported-expression"]);
    let fixed =
        "const KEY = \"count\";\nconst Box = pattern(() => ({ [KEY]: 1, [\"total\"]: 2 }));\n";
    assert_eq!(ids(&check(fixed)), Vec::<&str>::new());
}

#[test]
fn computed_that_calls_an_aggregate_or_takes_the_whole_array_is_not_promoted() {
    let aggregate = "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ total: computed(() => prices.sum()) }));\n";
    assert!(all(aggregate).contains(&"computed:not-promoted"));
    let whole = "const Box = pattern<{ prices: number[] }>(({ prices }) => ({ shares: computed(() => prices.map((price, _index, every) => price / every.length)) }));\n";
    assert!(all(whole).contains(&"computed:not-promoted"));
}

#[test]
fn fabric_value_class_is_constructed_in_a_function_body() {
    let module = "import { FabricBytes } from \"commonfabric\";\nfunction bytes() { return new FabricBytes(new Uint8Array(2)); }\n";
    assert_eq!(ids(&check(module)), Vec::<&str>::new());
}

#[test]
fn handle_declared_through_an_interface_of_another_module_is_recognized() {
    let types = "import type { Writable } from \"commonfabric\";\nexport interface Tray { donuts: Writable<string[]> }\nexport type Trays = { main: Tray };\n";
    let user = "import { handler } from \"commonfabric\";\nimport type { Trays } from \"./types.ts\";\nexport const list = handler<unknown, Trays>((_, state) => { const names = state.main.donuts.map((donut) => donut); console.log(names); });\n";
    assert_eq!(
        ids(&check_program(&[("types.ts", types), ("user.ts", user)])),
        ["cell:collection-method-in-function"]
    );
}

#[test]
fn call_of_a_property_in_the_reactive_tier_is_decided_by_its_declared_type() {
    let factory = "const Box = pattern<{ card: PatternFactory<{ name: string }, string>; name: string }>(({ card, name }) => ({ shown: card({ name }) }));\n";
    assert_eq!(ids(&check(factory)), Vec::<&str>::new());
    let member = "const Box = pattern<{ tray: { card: PatternFactory<{ name: string }, string> }; name: string }>(({ tray, name }) => ({ shown: tray.card({ name }) }));\n";
    assert_eq!(ids(&check(member)), Vec::<&str>::new());
    let method = "const Box = pattern<{ names: string[]; name: string }>(({ names, name }) => ({ at: names.push(name) }));\n";
    assert_eq!(ids(&check(method)), ["reactive:unsupported-call"]);
}

#[test]
fn stored_list_of_primitives_is_a_collection_of_plain_values() {
    let primitive = "const pick = handler<unknown, { name: string }>(() => {});\nconst Box = pattern<{ names: string[] }>(({ names }) => ({ rows: names.map((name) => <button onClick={pick({ name })}>{name}</button>) }));\n";
    assert_eq!(ids(&check(primitive)), ["collection:shared-element-state"]);
    let records = "const pick = handler<unknown, { donut: { name: string } }>(() => {});\nconst Box = pattern<{ donuts: { name: string }[] }>(({ donuts }) => ({ rows: donuts.map((donut) => <button onClick={pick({ donut })}>{donut.name}</button>) }));\n";
    assert_eq!(ids(&check(records)), Vec::<&str>::new());
}

#[test]
fn write_through_a_handle_in_the_reactive_tier_is_refused_for_an_annotated_input() {
    let module = "interface Input { count: Writable<number> }\nconst Box = pattern<Input>(({ count }) => ({ next: count.set(1) }));\n";
    assert_eq!(ids(&check(module)), ["cell:method-tier"]);
}

#[test]
fn intersection_of_object_types_is_computed_and_keeps_both_properties() {
    let module = "type Named = { name: string };\ntype Priced = Named & { price: Writable<number> };\nconst bump = handler<unknown, Priced>((_, state) => { const prices = state.price.map((price: number) => price); console.log(prices); });\n";
    assert_eq!(ids(&check(module)), ["cell:collection-method-in-function"]);
}

#[test]
fn default_given_as_the_type_of_a_literal_constant_is_static() {
    let module = "const EMPTY = { name: \"\", toppings: [] };\ninterface Input { donut: Default<{ name: string; toppings: string[] }, typeof EMPTY> }\n";
    assert_eq!(ids(&check(module)), Vec::<&str>::new());
}

#[test]
fn default_given_as_the_type_of_an_annotated_literal_constant_is_static() {
    let module = "interface Viewer { name?: string }\nconst EMPTY: Viewer = {};\ninterface Input { viewer: Writable<Viewer | Default<typeof EMPTY>> }\n";
    assert_eq!(ids(&check(module)), Vec::<&str>::new());
    let computed = "function build() { return { name: \"plain\" }; }\nconst BUILT = build();\ninterface Input { viewer: Default<{ name: string }, typeof BUILT> }\n";
    assert_eq!(ids(&check(computed)), ["default:not-static"]);
}

#[test]
fn get_on_a_value_that_declares_its_own_get_is_not_reported() {
    let module = "interface Source { get(): string[] }\nfunction names(source: Source) { return source.get(); }\n";
    assert_eq!(ids(&check(module)), Vec::<&str>::new());
}

#[test]
fn optional_get_on_a_union_with_a_value_that_declares_get_is_not_reported() {
    let module =
        "function read(source: { get?: () => unknown } | undefined) { return source?.get?.(); }\n";
    assert_eq!(ids(&check(module)), Vec::<&str>::new());
}

#[test]
fn overload_that_retypes_a_link_is_described_with_the_type_that_replaces_it() {
    let module = "interface Link { id: string }\n\
        function addOf(box: Cell<Link>): Cell<{ add: number }>;\n\
        function addOf(box: Cell<Link>): unknown { return box; }\n";
    let analysis = analyze(&[SourceFile {
        path: "case.ts".to_string(),
        text: format!("{PRELUDE}{module}"),
    }]);
    let overloads = &analysis.modules[0].overloads;
    assert_eq!(overloads.len(), 1);
    assert_eq!(overloads[0].name, "addOf");
    assert_eq!(overloads[0].parameters, ["Cell<{ id: string }>"]);
    assert_eq!(overloads[0].result, "Cell<{ add: number }>");
    assert_eq!(overloads[0].returns, "the parameter `box`");
    assert_eq!(
        overloads[0].declared_instead.as_deref(),
        Some("Cell<{ id: string; add: number }>")
    );
}

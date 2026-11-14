//! One refused and one accepted snippet for each diagnostic the front end
//! implements.
//!
//! In a refused snippet, `/*!*/` stands just before the node the diagnostic
//! is reported at.

use pattern_compiler::catalog::{Status, CATALOG};
use pattern_compiler::diagnostics::{Diagnostic, Severity};
use pattern_compiler::program::{analyze, SourceFile};

const PRELUDE: &str = "import { action, Cell, computed, eventKey, fetchJson, generateText, wish, \
handler, grantSpaceAccess, ifElse, lift, llm, pattern, patternTool, SELF, sqliteDatabase, table, Writable, \
type Confidential, type Default, type PatternFactory, type PerUser, type Reactive, type WriteAuthorizedBy, \
exchangeRules, UI, UiAction, type Integrity, type MaxConfidentiality, type PolicyOf, type RequiresIntegrity, \
type TrustedActionWrite, type VNode } from \"commonfabric\";\n";
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
        "collection:reduce-accumulator",
        "const Box = pattern<{ names: string[] }>(({ names }) => ({ seen: /*!*/names.reduce((seen, name) => seen.add(name), new Set<string>()) }));",
        "const Box = pattern<{ names: string[] }>(({ names }) => ({ joined: names.reduce((joined, name) => joined + name, \"\") }));",
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
        "function-body:wish",
        "const find = handler<unknown, { last: Writable<unknown> }>((_, { last }) => { last.set(/*!*/wish({ query: \"#profile\" })); });",
        "const Box = pattern(() => { const profile = wish({ query: \"#profile\" }); return { profile }; });",
    ),
    case(
        "collection:shared-element-state",
        "const GLAZES = [\"plain\", \"glazed\"];\nconst Box = pattern(() => { const rows = GLAZES.map((glaze) => { const open = /*!*/new Writable(false); return <li onClick={() => open.set(!open.get())}>{glaze}</li>; }); return { rows }; });",
        "const GLAZES = [\"plain\", \"glazed\"];\nconst Box = pattern(() => { const rows = GLAZES.map((glaze, index) => { const open = new Writable(false); return <li onClick={() => open.set(!open.get())}>{index + 1}. {glaze}</li>; }); return { rows }; });",
    ),
    case(
        "function-body:instantiation-without-cause",
        "const Quote = pattern<{ id: string }>(({ id }) => ({ id }));\nconst quotes = lift((ids: string[]) => ids.map((id) => /*!*/Quote({ id })));",
        "const Quote = pattern<{ id: string }>(({ id }) => ({ id }));\nconst quotes = lift((ids: string[]) => ids.map((id) => Quote({ id }).for(id)));",
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
        "subset-type:tuple-rest",
        "type Row = [string, /*!*/...number[]];",
        "type Row = [string, number];",
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
        "subset-type:mismatch",
        "function price(count: number) { return count * 2; }\nconst TOTAL = price(/*!*/\"two\");",
        "function price(count: number) { return count * 2; }\nconst TOTAL = price(2);",
    ),
    case(
        "subset-type:cannot-infer-type-argument",
        "function empty<T>(): T[] { return []; }\nconst ROWS = /*!*/empty();",
        "function empty<T>(): T[] { return []; }\nconst ROWS = empty<string>();",
    ),
    case(
        "cast-validation:double-unknown",
        "function label(count: number) { return /*!*/count as unknown as string; }",
        "function label(count: number | string) { return count as unknown as number; }",
    ),
    case(
        "schema:unknown-type-access",
        "const save = handler<unknown, { note: unknown }>((_event, state) => { /*!*/state.note.title; });",
        "const save = handler<unknown, { note: { title: string } }>((_event, state) => { state.note.title; });",
    ),
    case(
        "schema:path-not-in-type",
        "function show(donut: { name: string }) { return /*!*/donut.glaze; }",
        "function show(donut: { name: string }) { return donut.name; }",
    ),
    case(
        "pattern:any-result-schema",
        "const Box = /*!*/pattern<{ note: unknown }>(({ note }) => note);",
        "const Box = pattern<{ note: unknown }, { note: unknown }>(({ note }) => ({ note }));",
    ),
    case(
        "pattern-result:unknown-type",
        "const Box = /*!*/pattern<{ note: unknown }>(({ note }) => ({ note }));",
        "const Box = pattern<{ note: string }>(({ note }) => ({ note }));",
    ),
    case(
        "pattern-result:opaque-reserved-key",
        "const Box = pattern<{ name: string }, /*!*/{ [UI]: unknown }>(({ name }) => ({ [UI]: <div>{name}</div> }));",
        "const Box = pattern<{ name: string }, { [UI]: VNode }>(({ name }) => ({ [UI]: <div>{name}</div> }));",
    ),
    case(
        "reactive-capture:unknown-type",
        "const Box = pattern<{ note: unknown }, { size: number }>(({ note }) => ({ size: /*!*/computed(() => String(note).length) }));",
        "const Box = pattern<{ note: string }, { size: number }>(({ note }) => ({ size: computed(() => String(note).length) }));",
    ),
    case(
        "cfc-label:conflict",
        "type Secret = /*!*/Integrity<Integrity<string, [\"baker\"]>, [\"owner\"]>;",
        "type Secret = Confidential<Confidential<string, [\"baker\"]>, [\"owner\"]>;",
    ),
    case(
        "cfc-label:cast-ignored",
        "function seal(text: string) { return /*!*/text as Confidential<string, [\"secret\"]>; }",
        "function open(text: Confidential<string, [\"secret\"]>) { return text as string; }",
    ),
    case(
        "cfc-policy-of",
        "const rules = [1];\ntype Secret = Confidential<string, [/*!*/PolicyOf<typeof rules>]>;",
        "export const rules = exchangeRules([]);\ntype Secret = Confidential<string, [PolicyOf<typeof rules>]>;",
    ),
    case(
        "cfc-policy-authoring",
        "function make() { return /*!*/exchangeRules([]); }",
        "export const rules = exchangeRules([]);",
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
    case(
        "mergeable-push:read-then-push",
        "const add = handler<{ n: number }, { rows: Cell<number[]> }>((event, state) => { if (state.rows.get().length < 3) { /*!*/state.rows.push(event.n); } });",
        "const add = handler<{ n: number }, { rows: Cell<number[]> }>((event, state) => { state.rows.push(event.n); });",
    ),
    case(
        "footprint:widened",
        "const show = lift((x: { donut: { name: string; price: number } }) => JSON.stringify(/*!*/x.donut));",
        "const show = lift((x: { donut: { name: string; price: number } }) => JSON.stringify({ name: x.donut.name }));",
    ),
    case(
        "footprint:dynamic-read",
        "const read = lift((x: { on: boolean; count: Cell<number> }) => { if (x.on) { return /*!*/x.count.get(); } return 0; });",
        "const read = lift((x: { on: boolean; count: Cell<number> }) => { const n = x.count.get(); return x.on ? n : 0; });",
    ),
    case(
        "footprint:materializer",
        "const tally = lift((x: { counts: Cell<Record<string, number>>; flavor: string }) => { /*!*/x.counts.key(x.flavor).set(1); return 1; });",
        "const tally = lift((x: { counts: Cell<Record<string, number>> }) => { x.counts.key(\"glazed\").set(1); return 1; });",
    ),
    case(
        "side-write:not-idempotent",
        "const bump = lift((x: { count: Cell<number> }) => { /*!*/x.count.set(x.count.get() + 1); return 1; });",
        "const bump = lift((x: { count: Cell<number>; from: Cell<number> }) => { x.count.set(x.from.get() + 1); return 1; });",
    ),
    case(
        "cfc-flow:write-policy",
        "interface Note { body: WriteAuthorizedBy<string, typeof save> }\nconst save = handler<{ text: string }, { note: Cell<Note> }>((event, state) => { state.note.key(\"body\").set(event.text); });\nconst other = handler<{ text: string }, { note: Cell<Note> }>((event, state) => { /*!*/state.note.key(\"body\").set(event.text); });\nexport const P = pattern<{ note: Cell<Note> }>(({ note }) => ({ save: save({ note }), other: other({ note }) }));",
        "interface Note { body: WriteAuthorizedBy<string, typeof save> }\nconst save = handler<{ text: string }, { note: Cell<Note> }>((event, state) => { state.note.key(\"body\").set(event.text); });\nexport const P = pattern<{ note: Cell<Note> }>(({ note }) => ({ save: save({ note }) }));",
    ),
    case(
        "cfc-flow:max-confidentiality",
        "const gate = handler<{ t: string }, { v: MaxConfidentiality<Confidential<string, [\"secret\"]>, [\"public\"]>; n: Cell<number> }>(/*!*/(event, state) => { if (state.v) state.n.set(1); });\nexport const P = pattern<{ v: MaxConfidentiality<Confidential<string, [\"secret\"]>, [\"public\"]>; n: Cell<number> }>(({ v, n }) => ({ gate: gate({ v, n }) }));",
        "const gate = handler<{ t: string }, { v: MaxConfidentiality<Confidential<string, [\"secret\"]>, [\"secret\"]>; n: Cell<number> }>((event, state) => { if (state.v) state.n.set(1); });\nexport const P = pattern<{ v: MaxConfidentiality<Confidential<string, [\"secret\"]>, [\"secret\"]>; n: Cell<number> }>(({ v, n }) => ({ gate: gate({ v, n }) }));",
    ),
    case(
        "cfc-flow:required-integrity",
        "const gate = handler<{ t: string }, { v: RequiresIntegrity<Integrity<string, [\"draft\"]>, [\"reviewed\"]>; n: Cell<number> }>(/*!*/(event, state) => { if (state.v) state.n.set(1); });\nexport const P = pattern<{ v: RequiresIntegrity<Integrity<string, [\"draft\"]>, [\"reviewed\"]>; n: Cell<number> }>(({ v, n }) => ({ gate: gate({ v, n }) }));",
        "const gate = handler<{ t: string }, { v: RequiresIntegrity<Integrity<string, [\"reviewed\"]>, [\"reviewed\"]>; n: Cell<number> }>((event, state) => { if (state.v) state.n.set(1); });\nexport const P = pattern<{ v: RequiresIntegrity<Integrity<string, [\"reviewed\"]>, [\"reviewed\"]>; n: Cell<number> }>(({ v, n }) => ({ gate: gate({ v, n }) }));",
    ),
    case(
        "cfc-flow:write-floor",
        "export const P = pattern<{ a: Integrity<string, [\"reviewed\"]>; b: Integrity<string, [\"draft\"]> }, { out: RequiresIntegrity<string, [\"reviewed\"]> }>(({ a, b }) => ({ out: /*!*/a + b }));",
        "export const P = pattern<{ a: Integrity<string, [\"reviewed\"]>; b: Integrity<string, [\"reviewed\"]> }, { out: RequiresIntegrity<string, [\"reviewed\"]> }>(({ a, b }) => ({ out: a + b }));",
    ),
    case(
        "cfc-flow:writer-fit",
        "export const P = pattern<{ v: Confidential<string, [\"secret\"]> }, { out: Confidential<string, [\"public\"]> }>(({ v }) => ({ out: /*!*/v + \"!\" }));",
        "export const P = pattern<{ v: Confidential<string, [\"secret\"]> }, { out: Confidential<string, [\"secret\"]> }>(({ v }) => ({ out: v + \"!\" }));",
    ),
    case(
        "cfc-flow:ui-contract",
        "const SEND = \"send\";\nconst SURFACE = \"compose\";\ninterface Note { text: TrustedActionWrite<string, typeof send, typeof SEND, typeof SURFACE> }\nconst send = handler<{ text: string }, { note: Cell<Note> }>((event, state) => { state.note.key(\"text\").set(event.text); });\nexport const P = pattern<{ note: Cell<Note> }>(({ note }) => ({ [UI]: (<div><button /*!*/onClick={send({ note })}>Send</button></div>) }));",
        "const SEND = \"send\";\nconst SURFACE = \"compose\";\ninterface Note { text: TrustedActionWrite<string, typeof send, typeof SEND, typeof SURFACE> }\nconst send = handler<{ text: string }, { note: Cell<Note> }>((event, state) => { state.note.key(\"text\").set(event.text); });\nexport const P = pattern<{ note: Cell<Note> }>(({ note }) => ({ [UI]: (<div><section data-ui-pattern=\"compose\" data-ui-event-integrity=\"compose\"><UiAction action=\"send\" onClick={send({ note })}>Send</UiAction></section></div>) }));",
    ),
    case(
        "wish:computed-query",
        "export const P = pattern<{ tag: string }>(({ tag }) => ({ found: /*!*/wish<{ name: string }>({ query: tag }) }));",
        "export const P = pattern<{ tag: string }>(({ tag }) => ({ found: wish<{ name: string }>({ query: \"#note\" }) }));",
    ),
    case(
        "side-write:cycle",
        "const copy = lift((x: { from: Cell<number>; to: Cell<number> }) => { /*!*/x.to.set(x.from.get()); return 1; });\nexport const P = pattern<{ a: Cell<number>; b: Cell<number> }>(({ a, b }) => { const one = copy({ from: a, to: b }); const two = copy({ from: b, to: a }); return { one, two }; });",
        "const copy = lift((x: { from: Cell<number>; to: Cell<number> }) => { x.to.set(x.from.get()); return 1; });\nexport const P = pattern<{ a: Cell<number>; b: Cell<number>; c: Cell<number> }>(({ a, b, c }) => { const one = copy({ from: a, to: b }); const two = copy({ from: b, to: c }); return { one, two }; });",
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
fn state_cell_per_element_of_a_stored_list_of_primitives_is_refused() {
    let cell = "const Box = pattern<{ names: string[] }>(({ names }) => ({ rows: names.map((name) => { const open = new Writable(false); return { name, open }; }) }));\n";
    assert_eq!(ids(&check(cell)), ["collection:shared-element-state"]);
    let records = "const Box = pattern<{ donuts: { name: string }[] }>(({ donuts }) => ({ rows: donuts.map((donut) => { const open = new Writable(false); return { donut, open }; }) }));\n";
    assert_eq!(ids(&check(records)), Vec::<&str>::new());
}

#[test]
fn handler_bound_per_element_of_plain_values_with_no_state_cell_is_accepted() {
    let applied = "const GLAZES = [\"plain\", \"sugar\"];\nconst pick = handler<unknown, { glaze: string }>(() => {});\nconst Box = pattern(() => ({ rows: GLAZES.map((glaze) => <button onClick={pick({ glaze })}>{glaze}</button>) }));\n";
    assert_eq!(ids(&check(applied)), Vec::<&str>::new());
    let inline = "const GLAZES = [\"plain\", \"sugar\"];\nconst Box = pattern<{ chosen: Writable<string> }>(({ chosen }) => ({ rows: GLAZES.map((glaze) => <button onClick={() => chosen.set(glaze)}>{glaze}</button>) }));\n";
    assert_eq!(ids(&check(inline)), Vec::<&str>::new());
}

#[test]
fn key_flattens_a_handle_held_in_a_handle() {
    let module = "interface About { title: string }\ninterface Link { about: { record: Cell<About> } }\n\
        function aboutOf(room: Cell<Link>): Cell<About>;\n\
        function aboutOf(room: Cell<Link>): unknown { return room.key(\"about\").key(\"record\"); }\n";
    let analysis = analyze(&[SourceFile {
        path: "case.ts".to_string(),
        text: format!("{PRELUDE}{module}"),
    }]);
    let overload = &analysis.modules[0].overloads[0];
    assert_eq!(
        overload.returns,
        "`room.key(\"about\").key(\"record\")`, declared Cell<{ title: string }>"
    );
    assert!(overload.typed_without_overload);
}

#[test]
fn instantiation_in_a_loop_of_a_computation_without_a_cause_draws_a_warning() {
    let looped = "const Quote = pattern<{ id: string }>(({ id }) => ({ id }));\nconst Box = pattern<{ ids: string[] }>(({ ids }) => ({ quotes: computed(() => ids.map((id) => Quote({ id }))) }));\n";
    assert!(all(looped).contains(&"function-body:instantiation-without-cause"));
    assert_eq!(ids(&check(looped)), Vec::<&str>::new());
    let named = "const Quote = pattern<{ id: string }>(({ id }) => ({ id }));\nconst Box = pattern<{ ids: string[] }>(({ ids }) => ({ quotes: computed(() => ids.map((id) => Quote({ id }).for(id))) }));\n";
    assert!(!all(named).contains(&"function-body:instantiation-without-cause"));
    let once = "const Quote = pattern<{ id: string }>(({ id }) => ({ id }));\nconst Box = pattern<{ id: string }>(({ id }) => ({ quote: computed(() => Quote({ id })) }));\n";
    assert!(!all(once).contains(&"function-body:instantiation-without-cause"));
}

#[test]
fn function_type_in_a_probed_data_type_is_refused() {
    let module = "type Piece = { mentionable?: Piece[] | { get?: () => Piece[] } };\nconst Box = pattern<{ piece: Piece }>(({ piece }) => ({ piece }));\n";
    assert_eq!(ids(&check(module)), ["subset-type:function-in-data"]);
    let helper =
        "function read(source: { get?: () => string[] }) { return source.get?.() ?? []; }\n";
    assert_eq!(ids(&check(helper)), Vec::<&str>::new());
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

#[test]
fn instantiation_in_a_loop_of_an_authored_function_a_computation_calls_draws_a_warning() {
    let module = "const Quote = pattern<{ id: string }>(({ id }) => ({ id }));\nfunction quotesOf(ids: string[]) { return ids.map((id) => Quote({ id })); }\nconst quotes = lift((ids: string[]) => quotesOf(ids));\n";
    assert!(all(module).contains(&"function-body:instantiation-without-cause"));
    let handled = "const Quote = pattern<{ id: string }>(({ id }) => ({ id }));\nfunction quotesOf(ids: string[]) { return ids.map((id) => Quote({ id })); }\nconst add = handler<unknown, { ids: string[] }>((_, { ids }) => { quotesOf(ids); });\n";
    assert!(!all(handled).contains(&"function-body:instantiation-without-cause"));
}

#[test]
fn intersection_with_a_handle_is_refused() {
    let module = "type Odd = Writable<number> & { extra: string };\n";
    assert_eq!(ids(&check(module)), ["subset-type:empty-intersection"]);
}

#[test]
fn utility_type_the_subset_does_not_list_is_refused() {
    let module = "type Done = Awaited<string>;\n";
    assert_eq!(ids(&check(module)), ["stdlib:unsupported-member"]);
    let promise = "type Later = Promise<string>;\n";
    assert_eq!(ids(&check(promise)), ["function-body:unsupported-global"]);
}

#[test]
fn new_of_an_authored_function_in_a_frozen_data_initializer_is_refused() {
    let module = "function Donut() { return { name: \"plain\" }; }\nconst FIRST = new Donut();\n";
    assert_eq!(ids(&check(module)), ["function-body:constructor"]);
}

#[test]
fn state_cell_in_a_per_element_body_that_instantiates_a_child_is_accepted() {
    let module = "const GLAZES = [\"plain\", \"sugar\"];\nconst Row = pattern<{ glaze: string }>(({ glaze }) => ({ glaze }));\nconst Box = pattern(() => ({ rows: GLAZES.map((glaze) => { const open = new Writable(false); return { open, row: Row({ glaze }) }; }) }));\n";
    assert_eq!(ids(&check(module)), Vec::<&str>::new());
}

#[test]
fn type_name_that_resolves_to_nothing_is_refused() {
    let diagnostics = check("function show(donut: Dount) { return donut; }\n");
    assert_eq!(ids(&diagnostics), ["subset-type:mismatch"]);
    assert!(diagnostics[0]
        .message
        .contains("`Dount` resolves to nothing"));
}

#[test]
fn label_argument_is_decided_after_an_alias_is_replaced_by_its_body() {
    assert!(check(
        "type RecipeSecret = readonly [\"recipe-secret\"];\n\
         type Who<T> = { owner: T };\n\
         type Recipe = Confidential<string, RecipeSecret>;\n\
         type Owned = Confidential<string, [Who<\"baker\">]>;\n"
    )
    .is_empty());
    assert_eq!(
        ids(&check(
            "type Names = string[];\ntype Recipe = Confidential<string, Names>;\n"
        )),
        ["cfc-label:not-a-list"]
    );
    assert_eq!(
        ids(&check(
            "type Level = \"low\" | \"high\";\ntype Recipe = Confidential<string, [Level]>;\n"
        )),
        ["cfc-label:not-static"]
    );
}

#[test]
fn receiver_that_may_be_absent_is_refused() {
    let diagnostics = check(
        "function show(donut: { name: string } | undefined) { return donut.name; }\n\
         function safe(donut: { name: string } | undefined) { return donut?.name ?? (donut ? donut.name : \"\"); }\n",
    );
    assert_eq!(ids(&diagnostics), ["subset-type:mismatch"]);
    assert!(diagnostics[0]
        .message
        .contains("may be `null` or `undefined`"));
}

#[test]
fn module_scope_call_of_a_factory_value_is_refused_by_the_callee_s_type() {
    let diagnostics = check(
        "const Box = pattern<{ count: number }>(({ count }) => ({ count }));\n\
         const KINDS = { box: Box };\n\
         const MADE = KINDS.box({ count: 1 });\n\
         const SIZE = String(1).trim();\n",
    );
    assert_eq!(ids(&diagnostics), ["module-scope:runtime-call"]);
    assert_eq!(diagnostics[0].line, 4);
}

#[test]
fn default_named_by_typeof_takes_a_static_initializer() {
    assert!(check(
        "const STEP = -1;\n\
         const BASE = { size: 1, tags: [\"plain\"] };\n\
         const COPY = (BASE);\n\
         const NAMES = [\"ring\"] as const;\n\
         type A = Default<number, typeof STEP>;\n\
         type B = Default<{ size: number; tags: string[] }, typeof COPY>;\n\
         type C = Default<readonly string[], typeof NAMES>;\n"
    )
    .is_empty());
    for refused in [
        "const TOTAL = 1 + 2;\ntype A = Default<number, typeof TOTAL>;\n",
        "const BASE = [1];\nconst ALL = [...BASE];\ntype A = Default<number[], typeof ALL>;\n",
        "const NAME = \"ring\";\nconst LABEL = `${NAME} donut`;\ntype A = Default<string, typeof LABEL>;\n",
        "const SIZES = { small: 1 };\ntype A = Default<number, typeof SIZES.small>;\n",
        "type A = Default<number, \"one\">;\n",
        "const NAME = \"ring\";\ntype A = Default<number, typeof NAME>;\n",
    ] {
        assert_eq!(ids(&check(refused)), ["default:not-static"], "{refused}");
    }
}

#[test]
fn type_operator_on_an_operand_outside_its_table_is_refused() {
    assert!(check(
        "interface Donut { name: string; glaze: string }\n\
         function priceOf(donut: Donut): number { return donut.name.length; }\n\
         const save = handler<{ name: string }, { count: number }>((_event, _state) => {});\n\
         const Box = pattern<{ name: string }, { name: string }>(({ name }) => ({ name }));\n\
         type A = Pick<Donut, \"name\"> | Omit<Donut, \"name\" | \"glaze\"> | Partial<Donut>;\n\
         type B = ReturnType<typeof priceOf> | Parameters<typeof priceOf>[0];\n\
         type C = ReturnType<typeof save> | Parameters<typeof Box>[0];\n"
    )
    .is_empty());
    for refused in [
        "interface Donut { name: string }\ntype A = Pick<Donut, \"glaze\">;\n",
        "interface Donut { name: string }\ntype A = Omit<Donut, string>;\n",
        "type A = Partial<string | number>;\n",
        "type A = ReturnType<string>;\n",
        "type A = Parameters<{ name: string }>;\n",
    ] {
        assert_eq!(
            ids(&check(refused)),
            ["subset-type:operator-operand"],
            "{refused}"
        );
    }
}

#[test]
fn symbol_is_refused_as_an_operand_of_exclude() {
    assert_eq!(
        ids(&check(
            "type Key = Exclude<string | number, symbol>;\ntype Mark = { readonly mark: unique symbol };\n"
        )),
        ["schema-type:symbol", "schema-type:symbol"]
    );
}

#[test]
fn type_name_of_the_dom_library_is_an_unsupported_member() {
    for name in [
        "Event",
        "CustomEvent<{ value: string }>",
        "KeyboardEvent",
        "HTMLInputElement",
    ] {
        let diagnostics = check(&format!(
            "const save = handler<{name}, {{ name: Writable<string> }}>((_, state) => state.name.set(\"\"));\n"
        ));
        assert_eq!(ids(&diagnostics), ["stdlib:unsupported-member"], "{name}");
        assert!(
            diagnostics[0]
                .message
                .contains("declare the shape of the event"),
            "{}",
            diagnostics[0].message
        );
    }
    let diagnostics = check("function show(donut: Doughnut) { return donut; }\n");
    assert_eq!(ids(&diagnostics), ["subset-type:mismatch"]);
    // The names are those `lib.dom.d.ts` declares (§7.10), and not those
    // that look like one.
    for name in ["MediaQueryList", "AbortSignal", "Text"] {
        let diagnostics = check(&format!(
            "function show(value: {name}) {{ return value; }}\n"
        ));
        assert_eq!(ids(&diagnostics), ["stdlib:unsupported-member"], "{name}");
    }
    for name in ["DonutEvent", "HTMLDonutElement", "DOMDonut"] {
        let diagnostics = check(&format!(
            "function show(value: {name}) {{ return value; }}\n"
        ));
        assert_eq!(ids(&diagnostics), ["subset-type:mismatch"], "{name}");
    }
    // A name written once is counted once (§13, question 32).
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!(
            "{PRELUDE}type Change = CustomEvent<{{ value: string }}>;\n\
             const a = handler<Change, {{ n: Writable<number> }}>((_, state) => state.n.set(1));\n\
             const b = handler<Change, {{ n: Writable<number> }}>((_, state) => state.n.set(2));\n"
        ),
    }]);
    assert_eq!(
        analysis.modules[0]
            .counts
            .get("types:sites:a type name of the DOM library: CustomEvent"),
        Some(&1)
    );
}

#[test]
fn property_read_on_a_data_position_typed_unknown_is_an_unknown_type_access() {
    for snippet in [
        "const save = handler<unknown, { note: unknown }>((event, state) => { state.note?.title; });",
        "const save = handler<{ detail: unknown }, { n: Writable<number> }>((event) => { const d = event.detail; d.title; });",
        "const save = handler<unknown, { box: Writable<unknown> }>((_, state) => { state.box.get().title; });",
        "const Show = pattern<{ note: unknown }, { title: unknown }>(({ note }) => ({ title: note.title }));",
        "const Show = pattern<{ notes: { text: unknown }[] }, { titles: unknown[] }>(({ notes }) => ({ titles: notes.map((note) => note.text?.title) }));",
        "const Show = pattern<{ note: { body: unknown } }, { title: unknown }>(({ note }) => ({ title: computed(() => note.body.title) }));",
        "function first<T>(value: T) { return value.name; }",
    ] {
        assert_eq!(
            ids(&check(snippet)),
            ["schema:unknown-type-access"],
            "{snippet}"
        );
    }
}

#[test]
fn property_read_on_an_ordinary_value_typed_unknown_is_a_type_error() {
    for snippet in [
        "function show(value: unknown) { return value.name; }",
        "function show(text: string) { const parsed = JSON.parse(text); return parsed?.name; }",
        "function show() { try { return 1; } catch (error) { return error.message; } }",
    ] {
        let diagnostics = check(snippet);
        assert_eq!(ids(&diagnostics), ["subset-type:mismatch"], "{snippet}");
        assert!(
            diagnostics[0].message.contains("Narrow it"),
            "{}",
            diagnostics[0].message
        );
    }
}

#[test]
fn receiver_that_is_an_optional_property_is_refused() {
    let diagnostics = check(
        "function show(donut: { note?: string }) { return donut.note.length; }\n\
         function safe(donut: { note?: string }) { return (donut.note?.length ?? 0) + (donut.note ? donut.note.length : 0); }\n",
    );
    assert_eq!(ids(&diagnostics), ["subset-type:mismatch"]);
    assert!(diagnostics[0]
        .message
        .contains("may be `null` or `undefined`"));
}

#[test]
fn get_on_a_stream_names_the_presence_test_through_a_view_typed_unknown() {
    // §12.9, §10.2.
    let diagnostics = check(
        "import { Stream } from \"commonfabric\";\n\
         interface Inbox { receive?: Stream<string> }\n\
         function takes(inbox: Cell<Inbox>) { return inbox.key(\"receive\").get(); }\n",
    );
    assert_eq!(ids(&diagnostics), ["opaque-get:invalid-call"]);
    assert!(
        diagnostics[0]
            .message
            .contains("through a view typed `unknown`"),
        "{}",
        diagnostics[0].message
    );
    let diagnostics = check(
        "import { type ReadonlyCell, Stream } from \"commonfabric\";\n\
         interface Inbox { receive?: Stream<string> }\n\
         const hasReceive = (inbox: ReadonlyCell<{ receive?: unknown }>): boolean =>\n\
           inbox.key(\"receive\").get() !== undefined;\n\
         const takesOffers = (inbox: Cell<Inbox>): boolean => hasReceive(inbox);\n",
    );
    assert_eq!(ids(&diagnostics), [] as [&str; 0]);
}

#[test]
fn what_a_called_function_brings_into_a_body_is_reported_at_the_call_in_the_body() {
    // FA §3.6: "A write, a read through a handle, or a widening that a
    // summary brought into a body is reported at the call in the body's
    // own text, and the message also names the position inside the
    // function. Where calls nest, the call named is the outermost one,
    // the one written in the body."
    let source = "function inner(rows: Cell<number[]>, n: number) { if (rows.get().length < 3) { rows.push(n); } }\n\
function outer(rows: Cell<number[]>, n: number) { inner(rows, n); }\n\
const add = handler<{ n: number }, { rows: Cell<number[]> }>((event, state) => { outer(state.rows, event.n); });\n";
    let diagnostics = check(source);
    let found: Vec<&Diagnostic> = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.id == "mergeable-push:read-then-push")
        .collect();
    assert_eq!(found.len(), 1, "{diagnostics:?}");
    let prelude_lines = PRELUDE.matches('\n').count() as u32;
    assert_eq!(found[0].line, prelude_lines + 3);
    let text = "const add = handler<{ n: number }, { rows: Cell<number[]> }>((event, state) => { ";
    assert_eq!(found[0].column, text.len() as u32 + 1);
    let inside = format!("case.tsx:{}:", prelude_lines + 1);
    assert!(found[0].message.contains(&inside), "{}", found[0].message);
}

#[test]
fn a_widening_in_a_helper_is_reported_at_the_helper_only_where_the_helper_is_a_body() {
    // FA §3.6: "A function has no record of its own unless it is itself
    // a body of §1.2, as an authored function called from the reactive
    // tier is. ... So a widening in a helper is reported at the helper
    // where the helper is a body, and at the call in each body that calls
    // it. A function that only other bodies call is reported at those
    // calls alone."
    let lines = |snippet: &str| -> Vec<u32> {
        let mut lines: Vec<u32> = check(snippet)
            .iter()
            .filter(|diagnostic| diagnostic.id == "footprint:widened")
            .map(|diagnostic| diagnostic.line)
            .collect();
        lines.sort();
        lines
    };
    let helper = "const text = (donut: { name: string; price: number }): string =>\n  JSON.stringify(donut);\n";
    // The helper is called from a `lift` alone: one report, at the call.
    let only_bodies = format!(
        "{helper}const show = lift((x: {{ donut: {{ name: string; price: number }} }}) =>\n  text(x.donut));\n"
    );
    let base = lines("const one = 1;\n").len();
    assert_eq!(base, 0);
    let found = lines(&only_bodies);
    assert_eq!(found.len(), 1, "{found:?}");
    // Called from the reactive tier too, the helper is a body: its own
    // text is reported, and the call in the `lift`. The call in the
    // reactive tier is the use of that body, and is no call in a body.
    let reactive = format!(
        "{only_bodies}export const P = pattern<{{ donut: {{ name: string; price: number }} }}>(({{ donut }}) =>\n  ({{ shown: text(donut) }}));\n"
    );
    let found = lines(&reactive);
    assert_eq!(found.len(), 2, "{found:?}");
    assert_eq!(
        found[1] - found[0],
        2,
        "the helper, then the call in the lift"
    );
}

#[test]
fn wish_in_an_authored_function_and_in_a_computation_is_refused() {
    let helper = "function profile() { return wish({ query: \"#profile\" }); }\nconst Box = pattern(() => ({ profile: profile() }));\n";
    assert_eq!(ids(&check(helper)), ["function-body:wish"]);
    let lifted = "const find = lift((tag: string) => wish({ query: tag }));\n";
    assert_eq!(ids(&check(lifted)), ["function-body:wish"]);
}

//! Assignability (`language-subset.md` §7.5) at the three sites the checker
//! applies it: an argument against its parameter, a returned value against
//! a written return type, and an initializer against an annotation.

use pattern_compiler::program::{analyze, SourceFile};

const PRELUDE: &str = "import { Cell, handler, pattern, Stream, Writable, \
type Confidential, type ReadonlyCell } from \"commonfabric\";\n";

/// The `subset-type:mismatch` messages of a snippet, and its other errors.
fn check(snippet: &str) -> (Vec<String>, Vec<&'static str>) {
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("{PRELUDE}{snippet}"),
    }]);
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    let diagnostics = &analysis.modules[0].diagnostics;
    (
        diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.id == "subset-type:mismatch")
            .map(|diagnostic| diagnostic.message.clone())
            .collect(),
        diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.is_error() && diagnostic.id != "subset-type:mismatch")
            .map(|diagnostic| diagnostic.id)
            .collect(),
    )
}

fn assert_accepted(snippet: &str) {
    let (mismatches, others) = check(snippet);
    assert!(mismatches.is_empty(), "{mismatches:?} in:\n{snippet}");
    assert!(others.is_empty(), "{others:?} in:\n{snippet}");
}

/// Asserts one mismatch whose message contains `reason`.
fn assert_refused(snippet: &str, reason: &str) {
    let (mismatches, others) = check(snippet);
    assert!(others.is_empty(), "{others:?} in:\n{snippet}");
    assert_eq!(mismatches.len(), 1, "{mismatches:?} in:\n{snippet}");
    assert!(
        mismatches[0].contains(reason),
        "`{}` does not contain `{reason}`",
        mismatches[0]
    );
}

const DONUT: &str = "interface Donut { name: string; glaze?: \"plain\" | \"sugar\" }\n\
function show(donut: Donut): string { return donut.name; }\n";

#[test]
fn object_with_the_required_properties_is_assignable() {
    assert_accepted(&format!(
        "{DONUT}function run(other: {{ name: string; price: number }}) {{\n\
           return show({{ name: \"ring\" }}) + show({{ name: \"ring\", glaze: \"sugar\" }}) + show(other);\n\
         }}\n"
    ));
}

#[test]
fn object_without_a_required_property_is_refused() {
    assert_refused(
        &format!("{DONUT}function run() {{ return show({{ glaze: \"plain\" }}); }}\n"),
        "the property `name` is missing",
    );
}

#[test]
fn fresh_object_literal_with_an_undeclared_property_is_refused() {
    assert_refused(
        &format!("{DONUT}function run() {{ return show({{ name: \"ring\", price: 2 }}); }}\n"),
        "the object literal has the property `price`, which the type does not declare",
    );
}

#[test]
fn property_of_another_type_is_refused() {
    assert_refused(
        &format!("{DONUT}function run() {{ return show({{ name: 3 }}); }}\n"),
        "expected string, found 3",
    );
}

#[test]
fn const_keeps_its_literal_type_and_let_widens_it() {
    assert_accepted(
        "function glaze(kind: \"plain\" | \"sugar\") { return kind; }\n\
         const KIND = \"plain\";\n\
         function run(sweet: boolean) { return glaze(KIND) + glaze(sweet ? \"sugar\" : \"plain\"); }\n",
    );
    assert_refused(
        "function glaze(kind: \"plain\" | \"sugar\") { return kind; }\n\
         function run() { let kind = \"plain\"; return glaze(kind); }\n",
        "expected \"plain\" | \"sugar\", found string",
    );
    assert_refused(
        "function glaze(order: { kind: \"plain\" | \"sugar\" }) { return order.kind; }\n\
         function run() { const order = { kind: \"plain\" }; return glaze(order); }\n",
        "found string",
    );
}

#[test]
fn mutable_array_is_assignable_to_a_read_only_one_and_not_the_reverse() {
    assert_accepted(
        "function total(prices: readonly number[]) { return prices.length; }\n\
         function run(prices: number[]) { return total(prices) + total([1, 2]); }\n",
    );
    assert_refused(
        "function sort(prices: number[]) { return prices.length; }\n\
         function run(prices: readonly number[]) { return sort(prices); }\n",
        "a read-only array where a mutable one is declared",
    );
    assert_refused(
        "function rename(donut: { name: string }) { donut.name = \"ring\"; }\n\
         function run(donut: { readonly name: string }) { return rename(donut); }\n",
        "the property `name` is read-only",
    );
}

#[test]
fn cell_is_assignable_to_a_read_only_cell_of_a_wider_type_and_to_unknown() {
    assert_accepted(
        "function read(cell: ReadonlyCell<string | number>, any: unknown) { return [cell, any]; }\n\
         function same(cell: Cell<string>) { return cell; }\n\
         function run(cell: Cell<string>, other: Writable<string>) { return [read(cell, cell), same(other)]; }\n",
    );
}

#[test]
fn cell_is_assignable_to_a_cell_of_the_same_type_only() {
    assert_refused(
        "function write(cell: Cell<string | number>) { cell.set(1); }\n\
         function run(cell: Cell<string>) { return write(cell); }\n",
        "a cell that can be written has to hold the same type",
    );
    assert_refused(
        "function write(cell: Cell<string>) { cell.set(\"\"); }\n\
         function run(cell: ReadonlyCell<string>) { return write(cell); }\n",
        "a ReadonlyCell where a Cell is declared",
    );
}

#[test]
fn handle_is_not_assignable_to_an_object_type_with_the_same_methods() {
    assert_refused(
        "function read(source: { get(): string[] }) { return source.get(); }\n\
         function run(cell: Cell<string[]>) { return read(cell); }\n",
        "a cell where a value is declared",
    );
}

#[test]
fn value_is_not_assignable_to_a_handle() {
    assert_refused(
        "function read(cell: Cell<string>) { return cell.get(); }\n\
         function run(name: string) { return read(name); }\n",
        "a value where a cell is declared",
    );
}

#[test]
fn function_is_assignable_with_parameters_in_reverse_and_the_result_forward() {
    assert_accepted(
        "function each(visit: (name: \"plain\" | \"sugar\") => string | number) { return visit(\"plain\"); }\n\
         function label(name: string): string { return name; }\n\
         function run() { return each(label); }\n",
    );
    assert_refused(
        "function each(visit: (name: string) => string) { return visit(\"plain\"); }\n\
         function label(name: \"plain\"): string { return name; }\n\
         function run() { return each(label); }\n",
        "expected \"plain\", found string",
    );
}

#[test]
fn pattern_instance_is_assignable_to_a_view_of_its_result_and_to_a_cell_of_one() {
    assert_accepted(
        "interface NoteView { title: string }\n\
         const Note = pattern<{ title: string }, { title: string; body: string }>(({ title }) => ({ title, body: title }));\n\
         const add = handler<{ title: string }, { notes: Writable<NoteView[]> }>((event, { notes }) => {\n\
           const note = Note({ title: event.title });\n\
           keep(note, note, notes);\n\
         });\n\
         function keep(view: NoteView, cell: Cell<NoteView>, notes: Cell<NoteView[]>) { return [view, cell, notes]; }\n",
    );
}

#[test]
fn label_annotations_take_no_part() {
    assert_accepted(
        "function keep(secret: Confidential<string, [\"recipe\"]>): string { return secret; }\n\
         function run(name: string) { return keep(name); }\n",
    );
}

#[test]
fn wrong_argument_count_is_refused() {
    assert_refused(
        "function pair(a: string, b?: string) { return a + b; }\n\
         function run() { return pair(\"a\") + pair(\"a\", \"b\") + pair(); }\n",
        "expected 1 to 2 arguments, found 0",
    );
    assert_refused(
        "function one(a: string) { return a; }\n\
         function run() { return one(\"a\", \"b\"); }\n",
        "expected 1 argument, found 2",
    );
}

#[test]
fn returned_value_is_checked_against_the_written_return_type() {
    assert_accepted(
        "function price(count: number): number | undefined { if (count > 2) return count * 2; return undefined; }\n\
         const label = (count: number): string => `${count}`;\n",
    );
    assert_refused(
        "function price(count: number): number { if (count > 2) return count; return \"none\"; }\n",
        "expected number, found \"none\"",
    );
    assert_refused(
        "const label = (count: number): string => count;\n",
        "expected string, found number",
    );
}

#[test]
fn initializer_is_checked_against_the_annotation() {
    assert_accepted(
        "const PRICES: Record<string, number> = { plain: 1, sugar: 2 };\n\
         const NAMES: readonly string[] = [\"ring\"];\n\
         function run(names: string[] | undefined) { const own: string[] = names ?? []; return own; }\n",
    );
    assert_refused(
        "const PRICES: Record<string, number> = { plain: \"one\" };\n",
        "expected number, found \"one\"",
    );
}

#[test]
fn value_whose_type_is_not_evaluated_is_not_decided() {
    assert_accepted(
        "import type { Missing } from \"./missing.ts\";\n\
         function first<T>(items: T[]): T { return items[0]; }\n\
         function run(names: string[], other: Missing) { return show(first(names)) + show(other); }\n\
         function show(name: string) { return name; }\n",
    );
}

#[test]
fn narrowed_value_is_assignable_where_the_declared_one_is_not() {
    assert_accepted(
        "function show(name: string) { return name; }\n\
         function run(name: string | undefined) { if (!name) return \"\"; return show(name); }\n",
    );
    assert_refused(
        "function show(name: string) { return name; }\n\
         function run(name: string | undefined) { return show(name); }\n",
        "expected string, found string | undefined",
    );
}

#[test]
fn optional_parameter_and_property_take_undefined() {
    assert_accepted(
        "function show(name: string, note?: { text: string }) { return name + note?.text; }\n\
         function run(quiet: boolean, text: string | undefined) {\n\
           const order: { name: string; text?: string } = { name: \"ring\", text };\n\
           return show(order.name, quiet ? undefined : { text: \"fresh\" });\n\
         }\n",
    );
}

#[test]
fn value_typed_by_inference_is_decided_by_its_type() {
    assert_accepted(
        "function step(by: -1 | 0 | 1, wait: bigint, rows: string[]) { return [by, wait, rows]; }\n\
         const SECOND = 1000n;\n\
         function run(names: string[][], cell: Cell<{ box: { rows: string[] } }>) {\n\
           return step(-1, 60n * SECOND, names.flatMap((name) => name.length > 1 ? name : []))\n\
             .concat(step(0, SECOND, cell.key(\"box\", \"rows\").get()));\n\
         }\n",
    );
}

#[test]
fn value_checked_against_a_type_that_is_never_is_not_decided() {
    let (mismatches, _) = check(
        "type Tool = Cell<string> & { name: string };\n\
         function tool(name: string): Tool { return { name }; }\n",
    );
    assert!(mismatches.is_empty(), "{mismatches:?}");
}

#[test]
fn object_with_a_spread_of_an_untyped_value_is_not_decided() {
    assert_accepted(
        "import type { Missing } from \"./missing.ts\";\n\
         function row(base: Missing): { name: string; price: number } { return { ...base, price: 1 }; }\n",
    );
}

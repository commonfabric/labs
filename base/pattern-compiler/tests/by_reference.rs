//! Arguments bound by reference in tier R (`language-subset.md` §7.5.2): in
//! the argument of a pattern, of a handler, and of a `lift` result, a value
//! and a handle of that value stand for each other, position by position.

use pattern_compiler::program::{analyze, SourceFile};

const PRELUDE: &str = "import { Cell, computed, handler, lift, pattern, Stream, UI, Writable, \
type ComparableCell, type OpaqueCell, type ReadonlyCell, type SqliteDb, type WriteonlyCell } from \"commonfabric\";\n\
interface Donut { name: string; price: number }\n";

fn mismatches(snippet: &str) -> Vec<String> {
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("{PRELUDE}{snippet}"),
    }]);
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    analysis.modules[0]
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.id == "subset-type:mismatch")
        .map(|diagnostic| diagnostic.message.clone())
        .collect()
}

fn assert_accepted(snippet: &str) {
    let found = mismatches(snippet);
    assert!(found.is_empty(), "{found:?} in:\n{snippet}");
}

fn assert_refused(snippet: &str, reason: &str) {
    let found = mismatches(snippet);
    assert_eq!(found.len(), 1, "{found:?} in:\n{snippet}");
    assert!(
        found[0].contains(reason),
        "`{}` does not contain `{reason}`",
        found[0]
    );
}

const ROW: &str = "const Row = pattern<{ donut: Donut; shop: string; chosen: Writable<string[]> }, { name: string }>(\n\
  ({ donut }) => ({ name: donut.name }));\n\
const save = handler<unknown, { donuts: Writable<Donut[]>; shop: string }>((_, state) => { state.donuts.push({ name: state.shop, price: 1 }); });\n\
const total = lift((input: { donuts: Donut[]; tax: number }) => input.donuts.length * input.tax);\n";

#[test]
fn value_and_cell_stand_for_each_other_in_the_argument_of_a_pattern() {
    assert_accepted(&format!(
        "{ROW}const List = pattern<{{ donuts: Donut[]; shop: Writable<string>; chosen: string[] }}, {{ rows: {{ name: string }}[] }}>(\n\
           ({{ donuts, shop, chosen }}) => ({{ rows: donuts.map((donut) => Row({{ donut, shop, chosen }})) }}));\n"
    ));
}

#[test]
fn value_and_cell_stand_for_each_other_in_the_state_of_a_handler() {
    assert_accepted(&format!(
        "{ROW}const List = pattern<{{ donuts: Donut[]; shop: Writable<string> }}, {{ save: Stream<unknown> }}>(\n\
           ({{ donuts, shop }}) => ({{ save: save({{ donuts, shop }}) }}));\n"
    ));
}

#[test]
fn cell_stands_for_its_value_in_the_argument_of_a_lift_result() {
    assert_accepted(&format!(
        "{ROW}const List = pattern<{{ donuts: Writable<Donut[]>; tax: ReadonlyCell<number> }}, {{ total: number }}>(\n\
           ({{ donuts, tax }}) => ({{ total: total({{ donuts, tax }}) }}));\n"
    ));
}

#[test]
fn rule_reaches_inside_the_value_type_of_a_handle() {
    assert_accepted(
        "const Inner = pattern<{ a: Writable<Cell<Donut>[]>; b: Writable<Donut[]> }, { n: number }>(({ a }) => ({ n: 1 }));\n\
         const Outer = pattern<{ a: Writable<Donut[]>; b: Writable<Cell<Donut>[]> }, { n: number }>(\n\
           ({ a, b }) => Inner({ a, b }));\n",
    );
}

#[test]
fn value_of_another_type_is_refused_where_a_cell_is_declared() {
    assert_refused(
        &format!(
            "{ROW}const List = pattern<{{ donuts: string[]; shop: string }}, {{ save: Stream<unknown> }}>(\n\
               ({{ donuts, shop }}) => ({{ save: save({{ donuts, shop }}) }}));\n"
        ),
        "a cell of the value's type would not be assignable to the declared handle",
    );
}

#[test]
fn authored_function_called_in_tier_r_is_checked_without_the_rule() {
    assert_refused(
        "function label(shop: string): string { return shop; }\n\
         const List = pattern<{ shop: Writable<string> }, { label: string }>(({ shop }) => ({ label: label(shop) }));\n",
        "a cell where a value is declared",
    );
    assert_refused(
        "function first(names: Cell<string[]>): number { return names.get().length; }\n\
         const List = pattern<{ names: string[] }, { n: number }>(({ names }) => ({ n: first(names) }));\n",
        "a value where a cell is declared",
    );
}

#[test]
fn rule_does_not_hold_in_a_function_body() {
    assert_refused(
        &format!(
            "{ROW}const add = handler<unknown, {{ donuts: Donut[]; shop: string }}>((_, state) => {{\n\
               save({{ donuts: state.donuts, shop: state.shop }});\n\
             }});\n"
        ),
        "a value where a cell is declared",
    );
    assert_refused(
        &format!(
            "{ROW}const List = pattern<{{ donuts: Writable<Donut[]>; tax: number }}, {{ total: number }}>(\n\
               ({{ donuts, tax }}) => ({{ total: computed(() => total({{ donuts, tax }})) }}));\n"
        ),
        "a cell where a value is declared",
    );
}

#[test]
fn rule_does_not_hold_for_a_returned_value_or_an_annotation() {
    assert_refused(
        "const List = pattern<{ shop: Writable<string> }, { shop: string }>(({ shop }) => {\n\
           const out: { shop: string } = { shop };\n\
           return out;\n\
         });\n",
        "a cell where a value is declared",
    );
}

#[test]
fn undefined_is_accepted_where_the_declared_property_is_optional() {
    assert_accepted(
        "const Note = pattern<{ note?: Writable<string>; seen: ReadonlyCell<string | undefined> }, { n: number }>(() => ({ n: 1 }));\n\
         const Outer = pattern<{ note?: string; seen: string }, { n: number }>(({ note, seen }) => Note({ note, seen }));\n",
    );
    assert_refused(
        "const Note = pattern<{ note: Writable<string> }, { n: number }>(() => ({ n: 1 }));\n\
         const Outer = pattern<{ note: string | undefined }, { n: number }>(({ note }) => Note({ note }));\n",
        "the value and the cell differ by `undefined`",
    );
    assert_refused(
        "const Note = pattern<{ note: Writable<string | undefined> }, { n: number }>(() => ({ n: 1 }));\n\
         const Outer = pattern<{ note: string }, { n: number }>(({ note }) => Note({ note }));\n",
        "the value and the cell differ by `undefined`",
    );
}

#[test]
fn cell_that_cannot_be_read_is_refused_where_a_value_is_declared() {
    for kind in ["WriteonlyCell", "ComparableCell", "OpaqueCell"] {
        assert_refused(
            &format!(
                "const Show = pattern<{{ name: string }}, {{ n: number }}>(() => ({{ n: 1 }}));\n\
                 const Outer = pattern<{{ name: {kind}<string> }}, {{ n: number }}>(({{ name }}) => Show({{ name }}));\n"
            ),
            "cannot be read, so it does not stand for the value",
        );
    }
}

#[test]
fn value_is_never_accepted_for_a_stream_or_a_sqlite_handle() {
    assert_refused(
        "const Show = pattern<{ go: Stream<string> }, { n: number }>(() => ({ n: 1 }));\n\
         const Outer = pattern<{ go: string }, { n: number }>(({ go }) => Show({ go }));\n",
        "a value where a Stream is declared",
    );
    assert_refused(
        "const Show = pattern<{ db: SqliteDb }, { n: number }>(() => ({ n: 1 }));\n\
         const Outer = pattern<{ db: { name: string } }, { n: number }>(({ db }) => Show({ db }));\n",
        "a value where a Sqlite is declared",
    );
    assert_refused(
        "const Show = pattern<{ go: string }, { n: number }>(() => ({ n: 1 }));\n\
         const Outer = pattern<{ go: Stream<string> }, { n: number }>(({ go }) => Show({ go }));\n",
        "a Stream has no value to read",
    );
}

#[test]
fn literal_is_checked_against_the_value_type_of_the_declared_cell() {
    assert_accepted(
        "const Show = pattern<{ title: Writable<string>; rows: Writable<Donut[]>; kind: Writable<\"a\" | \"b\"> }, { n: number }>(() => ({ n: 1 }));\n\
         const Outer = pattern<{ n: number }, { n: number }>(() => Show({ title: \"ring\", rows: [{ name: \"ring\", price: 1 }], kind: \"a\" }));\n",
    );
    assert_refused(
        "const Show = pattern<{ title: Writable<string> }, { n: number }>(() => ({ n: 1 }));\n\
         const Outer = pattern<{ n: number }, { n: number }>(() => Show({ title: 3 }));\n",
        "expected string, found 3",
    );
}

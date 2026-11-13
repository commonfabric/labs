//! The types the checker gives the receivers of method calls: from a
//! declaration, from the result of a call, from a standard-library member,
//! from an operator or a literal, and from the callee of a callback.
//!
//! Each snippet is checked through the count the corpus measurement uses:
//! every method call in it has a typed receiver, or the receiver is counted
//! under the reason it has no type.

use pattern_compiler::program::{analyze, SourceFile};

const PRELUDE: &str =
    "import { Cell, computed, handler, lift, pattern, Writable } from \"commonfabric\";\n";

/// The labels under which the receivers of a snippet are counted, other
/// than "typed", and the identifiers of its errors.
fn untyped(snippet: &str) -> (Vec<String>, Vec<&'static str>) {
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("{PRELUDE}{snippet}"),
    }]);
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    let module = &analysis.modules[0];
    let labels = module
        .counts
        .keys()
        .filter_map(|key| key.strip_prefix("types:receiver:"))
        .filter(|label| *label != "typed")
        .map(str::to_string)
        .collect();
    let errors = module
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.is_error())
        .map(|diagnostic| diagnostic.id)
        .collect();
    (labels, errors)
}

fn assert_typed(snippet: &str) {
    let (labels, errors) = untyped(snippet);
    assert!(
        labels.is_empty(),
        "untyped receivers {labels:?} in:\n{snippet}"
    );
    assert!(errors.is_empty(), "errors {errors:?} in:\n{snippet}");
}

#[test]
fn call_of_a_function_with_a_written_return_type_has_that_type() {
    assert_typed(
        "function price(): number { return 1; }\nfunction show() { return price().toFixed(2); }\n",
    );
}

#[test]
fn call_of_a_function_with_an_expression_body_has_the_type_of_the_expression() {
    assert_typed("const label = (n: number) => `${n} donuts`;\nfunction show() { return label(1).trim(); }\n");
}

#[test]
fn call_of_a_function_with_a_single_return_has_the_type_returned() {
    assert_typed(
        "function named(names: string[]) { return names.filter((name) => name.length > 0); }\n\
         function show(names: string[]) { return named(names).join(\", \"); }\n",
    );
}

#[test]
fn standard_library_methods_have_result_types_through_a_chain() {
    assert_typed(
        "function slug(text: string) { return text.trim().toLowerCase().split(\" \").map((part) => part.trim()).join(\"-\"); }\n",
    );
}

#[test]
fn operators_and_conditionals_have_types() {
    assert_typed(
        "function show(name: string, count: number) {\n\
           return (name + count).trim() + (count > 1 ? name : \"one\").toUpperCase() + (count * 2).toFixed(0);\n\
         }\n",
    );
}

#[test]
fn object_and_array_literals_have_types() {
    assert_typed(
        "function show() {\n\
           const donut = { name: \"plain\", toppings: [\"sugar\"] };\n\
           return donut.name.trim() + donut.toppings.map((topping) => topping.trim()).join(\",\") + [1, 2].map((n) => n.toFixed(1)).length;\n\
         }\n",
    );
}

#[test]
fn members_of_standard_library_namespaces_have_result_types() {
    assert_typed(
        "function show(prices: Record<string, number>) {\n\
           const names = Object.keys(prices).map((name) => name.trim());\n\
           const rows = Object.entries(prices).map(([name, price]) => name.trim() + price.toFixed(2));\n\
           return names.concat(rows).join(\",\") + Math.floor(1.5).toFixed(0) + JSON.stringify(prices).trim();\n\
         }\n",
    );
}

#[test]
fn computed_has_the_type_its_function_returns() {
    assert_typed(
        "const Box = pattern<{ names: string[] }>(({ names }) => {\n\
           const upper = computed(() => names.map((name) => name.toUpperCase()));\n\
           return { joined: upper.join(\",\") };\n\
         });\n",
    );
}

#[test]
fn pattern_instantiation_and_lift_result_have_their_declared_types() {
    assert_typed(
        "const Child = pattern<{ name: string }, { label: string }>(({ name }) => ({ label: name }));\n\
         const double = lift((count: number) => count * 2);\n\
         const Box = pattern<{ name: string; count: number }>(({ name, count }) => ({\n\
           label: Child({ name }).label.trim(),\n\
           doubled: double(count).toFixed(0),\n\
         }));\n",
    );
}

#[test]
fn generic_function_takes_its_type_argument_from_an_argument() {
    assert_typed(
        "function first<T>(items: T[]): T | undefined { return items[0]; }\n\
         function show(names: string[]) { return first(names)?.trim(); }\n",
    );
}

#[test]
fn variable_of_a_for_of_loop_has_the_element_type() {
    assert_typed(
        "function trimmed(names: string[]) {\n\
           const out: string[] = [];\n\
           for (const name of names) { out.push(name.trim()); }\n\
           return out;\n\
         }\n",
    );
}

#[test]
fn receiver_inference_gives_up_on_is_counted_with_its_reason() {
    let (labels, errors) = untyped(
        "function show(source: { format: (count: number) => string }) { return source.format(1).trim(); }\n",
    );
    assert_eq!(
        labels,
        ["untyped: the result of a call of a function value"]
    );
    assert!(errors.is_empty());
}

#[test]
fn get_on_the_result_of_a_computed_is_refused() {
    let (_, errors) = untyped(
        "const Box = pattern<{ count: number }>(({ count }) => {\n\
           const doubled = computed(() => count * 2);\n\
           return { value: doubled.get() };\n\
         });\n",
    );
    assert_eq!(errors, ["opaque-get:invalid-call"]);
}

#[test]
fn mutating_method_on_an_inferred_array_is_refused_in_the_reactive_tier() {
    let (_, errors) = untyped(
        "const Box = pattern<{ names: string[]; name: string }>(({ names, name }) => {\n\
           const upper = computed(() => names.map((each) => each.toUpperCase()));\n\
           return { size: upper.push(name) };\n\
         });\n",
    );
    assert_eq!(errors, ["reactive:unsupported-call"]);
}

#[test]
fn key_with_a_computed_key_and_a_scoped_constructor_have_handle_types() {
    assert_typed(
        "const save = handler<unknown, { note: Writable<{ text: string }>; draft: Writable<string> }>((_, state) => {\n\
           state.note.key(\"text\").set(state.draft.get().trim());\n\
         });\n\
         const Box = pattern<{ notes: Writable<Record<string, { text: string }>>; id: string }>(({ notes, id }) => {\n\
           const draft = new Writable.perUser(\"\");\n\
           return { save: save({ note: notes.key(id), draft }), size: draft.get().length, text: notes.key(id).key(\"text\").get().trim() };\n\
         });\n",
    );
}

#[test]
fn value_with_a_default_member_in_its_union_has_the_type_of_the_value() {
    assert_typed(
        "import type { Default } from \"commonfabric\";\n\
         interface Composer { text: string }\n\
         type ComposerCell = Writable<Composer | Default<Record<PropertyKey, never>>>;\n\
         const clear = handler<unknown, { composer: ComposerCell }>((_, { composer }) => {\n\
           composer.key(\"text\").set(composer.get().text.trim());\n\
         });\n",
    );
}

#[test]
fn alias_reached_first_through_a_cycle_keeps_its_type() {
    assert_typed(
        "interface Message { text: string; replies?: MessageCell[]; composer?: ComposerCell }\n\
         type MessageCell = Writable<Message>;\n\
         type ComposerCell = MessageCell;\n\
         const read = handler<unknown, { first: Message; composer: ComposerCell }>((_, { composer }) => {\n\
           composer.get().text.trim();\n\
         });\n",
    );
}

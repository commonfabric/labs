//! Narrowing (`language-subset.md` §7.6): the type of a reference inside a
//! conditional, after an early return, and in a `switch`.
//!
//! In a snippet, `/*?*/` stands just before the expression whose type the
//! test names.

use pattern_compiler::program::{types_at_markers, SourceFile};

fn types(snippet: &str) -> Vec<String> {
    types_at_markers(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!(
            "import {{ action, Cell, handler, pattern }} from \"commonfabric\";\n{snippet}"
        ),
    }])
}

#[test]
fn typeof_narrows_a_union_in_both_branches() {
    assert_eq!(
        types(
            "function show(value: string | number | undefined) {\n\
               if (typeof value === \"string\") { return /*?*/value; }\n\
               else { return /*?*/value; }\n\
             }\n"
        ),
        ["string", "number | undefined"]
    );
}

#[test]
fn typeof_narrows_unknown_that_is_not_a_data_position() {
    assert_eq!(
        types(
            "function show(value: unknown) {\n\
               return typeof value === \"number\" ? /*?*/value : /*?*/value;\n\
             }\n"
        ),
        ["number", "unknown"]
    );
}

#[test]
fn kind_test_does_not_narrow_a_data_position_typed_unknown() {
    assert_eq!(
        types(
            "const save = handler<unknown, { note: unknown }>((event, state) => {\n\
               if (typeof event === \"string\") { /*?*/event; }\n\
               if (Array.isArray(state.note)) { /*?*/(state.note); }\n\
             });\n"
        ),
        ["unknown", "unknown"]
    );
}

#[test]
fn truthiness_removes_null_and_undefined() {
    assert_eq!(
        types(
            "function show(name: string | null | undefined, donut: { name: string } | undefined) {\n\
               if (name) { /*?*/name; } else { /*?*/name; }\n\
               if (!donut) { return /*?*/donut; }\n\
               return name && /*?*/donut;\n\
             }\n"
        ),
        ["string", "string | null | undefined", "undefined", "{ name: string }"]
    );
}

#[test]
fn equality_with_a_literal_or_null_narrows() {
    assert_eq!(
        types(
            "function show(glaze: \"plain\" | \"sugar\" | null, count: number | undefined) {\n\
               if (glaze === null) { return /*?*/glaze; }\n\
               if (glaze !== \"plain\") { return /*?*/glaze; }\n\
               if (count == null) { return /*?*/count; }\n\
               if (count === 0) { return /*?*/count; }\n\
               return [/*?*/glaze, /*?*/count];\n\
             }\n"
        ),
        ["null", "\"sugar\"", "undefined", "0", "\"plain\"", "number"]
    );
}

#[test]
fn in_narrows_a_union_of_object_types() {
    assert_eq!(
        types(
            "type Item = { donut: string } | { box: number };\n\
             function show(item: Item) {\n\
               if (\"donut\" in item) { return /*?*/item; }\n\
               return /*?*/item;\n\
             }\n"
        ),
        ["{ donut: string }", "{ box: number }"]
    );
}

#[test]
fn discriminant_property_narrows_a_union_of_object_types() {
    assert_eq!(
        types(
            "type Step = { kind: \"mix\"; minutes: number } | { kind: \"bake\"; degrees: number } | { kind: \"cool\" };\n\
             function show(step: Step) {\n\
               if (step.kind === \"mix\") { return /*?*/(step.minutes); }\n\
               if (step.kind !== \"bake\") { return /*?*/step; }\n\
               return /*?*/(step.degrees);\n\
             }\n"
        ),
        ["number", "{ kind: \"cool\" }", "number"]
    );
}

#[test]
fn switch_on_a_discriminant_narrows_in_each_case() {
    assert_eq!(
        types(
            "type Step = { kind: \"mix\"; minutes: number } | { kind: \"bake\"; degrees: number };\n\
             function show(step: Step) {\n\
               switch (step.kind) {\n\
                 case \"mix\": return /*?*/step;\n\
                 case \"bake\": return /*?*/step;\n\
               }\n\
             }\n"
        ),
        [
            "{ kind: \"mix\"; minutes: number }",
            "{ kind: \"bake\"; degrees: number }"
        ]
    );
}

#[test]
fn early_return_narrows_the_statements_after_it() {
    assert_eq!(
        types(
            "function show(donut: { name: string } | undefined, price: number | string) {\n\
               if (!donut) return \"\";\n\
               if (typeof price === \"string\") { throw new Error(price); }\n\
               const inner = () => /*?*/donut;\n\
               return /*?*/donut.name + /*?*/price;\n\
             }\n"
        ),
        ["{ name: string }", "{ name: string }", "number"]
    );
}

#[test]
fn property_path_is_narrowed_inside_its_function_only() {
    assert_eq!(
        types(
            "function show(order: { note: string | undefined }) {\n\
               if (!order.note) return \"\";\n\
               const inner = () => /*?*/(order.note);\n\
               return /*?*/(order.note);\n\
             }\n"
        ),
        ["string | undefined", "string"]
    );
}

#[test]
fn reassigned_binding_is_narrowed_by_a_condition_after_its_last_assignment() {
    assert_eq!(
        types(
            "function show(first: string | undefined) {\n\
               let name = first;\n\
               if (!name) { name = \"plain\"; }\n\
               if (name) { return /*?*/name; }\n\
               return \"\";\n\
             }\n"
        ),
        ["string"]
    );
}

#[test]
fn array_test_instanceof_and_a_type_predicate_narrow() {
    assert_eq!(
        types(
            "function isName(value: unknown): value is string { return typeof value === \"string\"; }\n\
             function show(value: string | string[], error: unknown, other: unknown) {\n\
               try { other; } catch (caught) { /*?*/caught; }\n\
               if (Array.isArray(value)) { return /*?*/value; }\n\
               if (error instanceof Error) { return /*?*/(error.message); }\n\
               if (isName(other)) { return /*?*/other; }\n\
               return /*?*/value;\n\
             }\n"
        ),
        ["unknown", "string[]", "string", "string", "string"]
    );
}

#[test]
fn non_null_assertion_removes_null_and_undefined() {
    assert_eq!(
        types("function show(name: string | null) { return /*?*/(name!); }\n"),
        ["string"]
    );
}

#[test]
fn element_at_a_literal_index_is_narrowed() {
    assert_eq!(
        types(
            "function show(parts: string[]) {\n\
               if (parts[0] === \"result\" || parts[0] === \"input\") { return \"\"; }\n\
               if (parts[1] === \"plain\") { return /*?*/(parts[1]); }\n\
               return /*?*/(parts[1]);\n\
             }\n"
        ),
        ["\"plain\"", "string"]
    );
}

#[test]
fn either_operand_of_or_holding_narrows_to_the_union_of_the_two() {
    assert_eq!(
        types(
            "function show(value: 1 | 2 | null | undefined, name: string | number | undefined) {\n\
               if (!(typeof name === \"string\" && name)) { /*?*/name; }\n\
               return value === 1 || value === 2 ? /*?*/value : null;\n\
             }\n"
        ),
        ["number | undefined | string", "1 | 2"]
    );
}

// ----- §7.8: which expressions are data positions -----

#[test]
fn kind_test_does_not_narrow_a_data_position_reached_through_a_const() {
    assert_eq!(
        types(
            "const save = handler<{ detail: unknown }, { box: Cell<unknown> }>((event, state) => {\n\
               const first = event;\n\
               const detail = first.detail;\n\
               if (typeof detail === \"string\") { /*?*/detail; }\n\
               const { detail: other } = event;\n\
               if (typeof other === \"string\") { /*?*/other; }\n\
               const held = state.box.get();\n\
               if (typeof held === \"string\") { /*?*/held; }\n\
             });\n"
        ),
        ["unknown", "unknown", "unknown"]
    );
}

#[test]
fn kind_test_does_not_narrow_in_the_reactive_tier_or_a_capture_of_it() {
    assert_eq!(
        types(
            "import { computed } from \"commonfabric\";\n\
             const Show = pattern<{ notes: { text: unknown }[]; one: { text: unknown } }, { n: unknown }>(({ notes, one }) => {\n\
               const text = one.text;\n\
               const shown = typeof text === \"string\" ? /*?*/text : \"\";\n\
               const all = notes.map((note) => typeof note.text === \"string\" ? /*?*/(note.text) : \"\");\n\
               const late = computed(() => typeof text === \"string\" ? /*?*/text : \"\");\n\
               return { n: [shown, all, late] };\n\
             });\n"
        ),
        ["unknown", "unknown", "unknown"]
    );
}

#[test]
fn kind_test_narrows_an_ordinary_value_typed_unknown() {
    assert_eq!(
        types(
            "const save = handler<{ text: string }, { name: Cell<string> }>((event, state) => {\n\
               const parsed = JSON.parse(event.text);\n\
               const same = parsed;\n\
               if (typeof same === \"string\") { /*?*/same; }\n\
               try { state.name.set(\"\"); } catch (error) { if (error instanceof Error) { /*?*/error; } }\n\
             });\n\
             function show(value: unknown) { if (Array.isArray(value)) { /*?*/value; } }\n"
        ),
        ["string", "Error", "unknown[]"]
    );
}

// ----- §7.6: a value that may be absent -----

#[test]
fn read_of_an_optional_property_has_undefined() {
    assert_eq!(
        types(
            "interface Donut { name: string; note?: string; glaze?: { kind: string } }\n\
             function show(donut: Donut, cell: Cell<Donut>) {\n\
               /*?*/(donut.note);\n\
               if (donut.note) { /*?*/(donut.note); }\n\
               const { note, name } = donut;\n\
               const { note: other = \"\" } = donut;\n\
               return [/*?*/note, /*?*/name, /*?*/other, /*?*/(cell.key(\"note\")), /*?*/(donut.glaze?.kind)];\n\
             }\n"
        ),
        [
            "string | undefined",
            "string",
            "string | undefined",
            "string",
            "string",
            "Cell<string | undefined>",
            "string | undefined"
        ]
    );
}

#[test]
fn optional_chain_in_the_reactive_tier_has_undefined() {
    assert_eq!(
        types(
            "const Show = pattern<{ donut: { name: string } }, { name: string | undefined }>(({ donut }) => ({ name: /*?*/(donut?.name) }));\n\
             function show(donut: { name: string }) { return /*?*/(donut?.name); }\n"
        ),
        ["string | undefined", "string"]
    );
}

// ----- §7.6: narrowing by an assignment to a `let` -----

#[test]
fn assignment_narrows_a_let_until_the_next_assignment() {
    assert_eq!(
        types(
            "function show(names: string[], fallback: string | undefined) {\n\
               let name: string | undefined = undefined;\n\
               /*?*/name;\n\
               name = \"ring\";\n\
               /*?*/name;\n\
               name = fallback;\n\
               /*?*/name;\n\
               if (!name) { name = names.join(\",\"); /*?*/name; }\n\
               return /*?*/name;\n\
             }\n"
        ),
        [
            "undefined",
            "string",
            "string | undefined",
            "string",
            "string | undefined"
        ]
    );
}

#[test]
fn condition_narrows_a_let_while_nothing_assigns_it() {
    assert_eq!(
        types(
            "function show(names: string[]) {\n\
               let best: string | undefined = names[0];\n\
               if (best) { /*?*/best; best = undefined; /*?*/best; }\n\
               if (!best) return \"\";\n\
               /*?*/best;\n\
               for (const name of names) { /*?*/best; if (name > \"m\") best = undefined; }\n\
               const late = () => /*?*/best;\n\
               return late();\n\
             }\n"
        ),
        [
            "string",
            "undefined",
            "string",
            "string | undefined",
            "string | undefined"
        ]
    );
}

#[test]
fn assignment_inside_a_loop_or_a_branch_does_not_narrow_after_it() {
    assert_eq!(
        types(
            "function show(names: string[]) {\n\
               let best: string | undefined = undefined;\n\
               for (const name of names) { if (name) best = name; }\n\
               /*?*/best;\n\
               let last: string | undefined = undefined;\n\
               for (const name of names) { /*?*/last; last = name; /*?*/last; }\n\
               return [best, last];\n\
             }\n"
        ),
        ["string | undefined", "string | undefined", "string"]
    );
}

// ----- §7.8: a handle of `unknown` -----

#[test]
fn key_on_a_handle_of_unknown_is_a_handle_of_unknown() {
    assert_eq!(
        types(
            "function walk(cell: Cell<unknown>, name: string) {\n\
               return [/*?*/(cell.key(\"a\", \"b\")), /*?*/(cell.key(name)), /*?*/(cell.get())];\n\
             }\n"
        ),
        ["Cell<unknown>", "Cell<unknown>", "unknown"]
    );
}

#[test]
fn action_has_the_event_type_its_callback_declares() {
    assert_eq!(
        types(
            "const Show = pattern<{ n: number }, { a: unknown }>(() => {\n\
               const add = action((event: { url: string }) => { event.url; });\n\
               const clear = action(() => {});\n\
               const typed = action<{ index: number }>((event) => { event.index; });\n\
               return { a: [/*?*/add, /*?*/clear, /*?*/typed] };\n\
             });\n"
        ),
        [
            "Stream<{ url: string }>",
            "Stream<void>",
            "Stream<{ index: number }>"
        ]
    );
}

#[test]
fn optional_chain_that_holds_narrows_its_receiver() {
    assert_eq!(
        types(
            "function show(pending: string | undefined, reply: { thread?: string } | undefined) {\n\
               if (pending?.trim()) { /*?*/pending; }\n\
               const a = reply?.thread === undefined ? /*?*/reply : /*?*/reply;\n\
               const b = reply?.thread !== undefined && /*?*/reply;\n\
               const c = reply?.thread === \"x\" ? /*?*/reply : /*?*/reply;\n\
               return [a, b, c];\n\
             }\n"
        ),
        [
            "string",
            "{ thread?: string } | undefined",
            "{ thread?: string }",
            "{ thread?: string }",
            "{ thread?: string }",
            "{ thread?: string } | undefined"
        ]
    );
}

#[test]
fn optional_chain_compared_with_a_present_value_narrows_its_receiver() {
    assert_eq!(
        types(
            "const KIND = \"offer\";\n\
             function show(entry: { kind: string; get?: () => string } | undefined, revision: string, maybe: string | undefined) {\n\
               const a = entry?.kind === KIND && /*?*/entry;\n\
               const b = entry?.kind === revision && /*?*/entry;\n\
               const c = entry?.kind === maybe && /*?*/entry;\n\
               const d = typeof entry?.get === \"function\" ? /*?*/entry : undefined;\n\
               return [a, b, c, d];\n\
             }\n"
        ),
        [
            "{ kind: string; get?: () => string }",
            "{ kind: string; get?: () => string }",
            "{ kind: string; get?: () => string } | undefined",
            "{ kind: string; get?: () => string }"
        ]
    );
}

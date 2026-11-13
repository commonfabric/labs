//! Narrowing (`language-subset.md` §7.6): the type of a reference inside a
//! conditional, after an early return, and in a `switch`.
//!
//! In a snippet, `/*?*/` stands just before the expression whose type the
//! test names.

use pattern_compiler::program::{types_at_markers, SourceFile};

fn types(snippet: &str) -> Vec<String> {
    types_at_markers(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("import {{ Cell, handler, pattern }} from \"commonfabric\";\n{snippet}"),
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
fn reassigned_binding_is_not_narrowed() {
    assert_eq!(
        types(
            "function show(first: string | undefined) {\n\
               let name = first;\n\
               if (!name) { name = \"plain\"; }\n\
               if (name) { return /*?*/name; }\n\
               return \"\";\n\
             }\n"
        ),
        ["string | undefined"]
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

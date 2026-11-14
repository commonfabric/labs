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

#[test]
fn let_of_an_enclosing_function_is_narrowed_where_one_function_assigns_it() {
    assert_eq!(
        types(
            "function index(names: string[]) {\n\
               let seen: Set<string> | undefined;\n\
               let other: string | undefined;\n\
               const reset = () => { other = undefined; };\n\
               return (name: string) => {\n\
                 if (seen === undefined) { seen = new Set(names); }\n\
                 if (other === undefined) { other = name; }\n\
                 reset();\n\
                 return [/*?*/seen, /*?*/other];\n\
               };\n\
             }\n"
        ),
        ["Set | undefined", "string | undefined"]
    );
    assert_eq!(
        types(
            "function index(names: string[]) {\n\
               let seen: Set<string> | undefined;\n\
               return (name: string) => {\n\
                 if (seen === undefined) { seen = new Set(names); /*?*/seen; }\n\
                 return name;\n\
               };\n\
             }\n"
        ),
        ["Set"]
    );
}

#[test]
fn typeof_object_narrows_an_ordinary_unknown_to_a_type_with_no_property() {
    assert_eq!(
        types(
            "function show(value: unknown) {\n\
               if (typeof value === \"object\") { /*?*/value; if (value !== null) { /*?*/value; } }\n\
               if (!value || typeof value !== \"object\") return 0;\n\
               return /*?*/value;\n\
             }\n"
        ),
        ["object | null", "object", "object"]
    );
}

#[test]
fn optional_chain_compared_with_undefined_narrows_the_path_it_reads() {
    assert_eq!(
        types(
            "function show(place: { latest?: bigint } | undefined, reply: { thread?: string } | undefined) {\n\
               const a = place?.latest === undefined ? 0n : /*?*/(place.latest);\n\
               const b = reply?.thread === undefined ? undefined : /*?*/(reply.thread);\n\
               return [a, b];\n\
             }\n"
        ),
        ["bigint", "string"]
    );
}

#[test]
fn property_of_a_type_parameter_is_read_through_its_constraint() {
    assert_eq!(
        types(
            "interface Entry { since: number }\n\
             function newest<T extends Entry>(entries: readonly T[]) {\n\
               return entries.map((entry) => /*?*/(entry.since));\n\
             }\n"
        ),
        ["number"]
    );
}

#[test]
fn interface_extends_a_native_type_operator() {
    assert_eq!(
        types(
            "interface Notice { id: string; room: string; note?: string }\n\
             interface Linked extends Omit<Notice, \"room\"> { room: number }\n\
             interface Whole extends Required<Notice> { extra: boolean }\n\
             function show(linked: Linked, whole: Whole) { return [/*?*/(linked.id), /*?*/(linked.room), /*?*/(whole.note)]; }\n"
        ),
        ["string", "number", "string"]
    );
}

#[test]
fn property_of_an_object_literal_keeps_a_declared_union_of_literals() {
    assert_eq!(
        types(
            "function show(kind: \"direct\" | \"group\") {\n\
               const bindings = { kind, plain: \"x\" };\n\
               return [/*?*/(bindings.kind), /*?*/(bindings.plain)];\n\
             }\n"
        ),
        ["\"direct\" | \"group\"", "string"]
    );
}

#[test]
fn well_formed_did_test_narrows_unknown_to_a_string() {
    assert_eq!(
        types(
            "import { isWellFormedDID } from \"commonfabric\";\n\
             function show(value: unknown) { return isWellFormedDID(value) && /*?*/value; }\n"
        ),
        ["string"]
    );
}

#[test]
fn assignment_of_a_container_without_type_arguments_narrows_to_the_declared_container() {
    assert_eq!(
        types(
            "function index(names: string[]) {\n\
               let seen: Map<string, string[]> | undefined;\n\
               return (name: string) => {\n\
                 if (seen === undefined) { seen = new Map(); for (const other of names) { /*?*/seen; } }\n\
                 return name;\n\
               };\n\
             }\n"
        ),
        ["Map"]
    );
}

// ----- §7.6: `"k" in x` on `object` and on an object type without `k` -----

#[test]
fn in_adds_the_property_to_object_and_a_kind_test_narrows_it() {
    assert_eq!(
        types(
            "function idOf(parsed: unknown): string | undefined {\n\
               if (typeof parsed !== \"object\" || parsed === null) return undefined;\n\
               const before = /*?*/parsed;\n\
               if (!(\"id\" in parsed)) return undefined;\n\
               const after = /*?*/parsed;\n\
               const read = /*?*/(parsed.id);\n\
               return typeof parsed.id === \"string\" ? /*?*/(parsed.id) : undefined;\n\
             }\n"
        ),
        ["object", "{ id: unknown }", "unknown", "string"]
    );
}

#[test]
fn several_in_tests_add_several_properties() {
    assert_eq!(
        types(
            "function f(x: object, y: { a: string }) {\n\
               if (\"id\" in x && \"name\" in x) { /*?*/x; }\n\
               if (\"b\" in y) { /*?*/y; } else { /*?*/y; }\n\
             }\n"
        ),
        [
            "{ id: unknown; name: unknown }",
            "{ a: string; b: unknown }",
            "{ a: string }"
        ]
    );
}

#[test]
fn typeof_object_narrows_an_ordinary_unknown_to_object_or_null() {
    assert_eq!(
        types(
            "function f(x: unknown) {\n\
               if (typeof x === \"object\") { /*?*/x; }\n\
             }\n"
        ),
        ["object | null"]
    );
}

#[test]
fn in_narrows_nothing_on_a_data_position() {
    assert_eq!(
        types(
            "const h = handler<unknown, { detail: unknown; box: object }>((event, state) => {\n\
               if (\"id\" in state.box) { /*?*/(state.box); }\n\
               const detail = state.detail;\n\
               if (typeof detail === \"object\" && detail !== null && \"id\" in detail) { /*?*/detail; }\n\
             });\n"
        ),
        ["object", "unknown"]
    );
}

#[test]
fn result_of_an_operator_and_a_let_are_ordinary_values() {
    // §7.8: neither is a data position, so a kind test narrows it.
    assert_eq!(
        types(
            "const h = handler<{ detail: unknown }, { fallback: unknown }>((event, state) => {\n\
               const either = event.detail ?? state.fallback;\n\
               if (typeof either === \"string\") { /*?*/either; }\n\
               let later = event.detail;\n\
               if (typeof later === \"number\") { /*?*/later; }\n\
               const same = event.detail;\n\
               if (typeof same === \"string\") { /*?*/same; }\n\
             });\n"
        ),
        ["string", "number", "unknown"]
    );
}

#[test]
fn conditional_with_an_unknown_branch_is_unknown_and_a_kind_test_narrows_it() {
    assert_eq!(
        types(
            "function f(value: object) {\n\
               const key = \"item_key\" in value ? value.item_key : undefined;\n\
               const a = /*?*/key;\n\
               if (typeof key !== \"string\" || /*?*/key.length !== 64) return undefined;\n\
               return /*?*/key;\n\
             }\n"
        ),
        ["unknown", "string", "string"]
    );
}

// By ruling: `elementById` yields a handle of the element type or
// `undefined`.
#[test]
fn element_by_id_yields_a_handle_of_the_element_or_undefined() {
    assert_eq!(
        types(
            "function f(rows: Cell<{ n: number }[]>, id: string) {\n\
               const row = rows.elementById(id);\n\
               /*?*/row; /*?*/(row.get()); /*?*/(rows.key(0));\n\
             }\n"
        ),
        [
            "Cell<{ n: number } | undefined>",
            "{ n: number } | undefined",
            "Cell<{ n: number }>"
        ]
    );
}

// By ruling: on a value of type `unknown` in a data position the only test
// is against `undefined`.
#[test]
fn property_read_after_a_typeof_test_of_a_data_position_stays_refused() {
    use pattern_compiler::program::analyze;
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: "import { handler } from \"commonfabric\";\n\
               const save = handler<unknown, { note: unknown }>((event, state) => {\n\
                 if (typeof state.note === \"string\") { state.note.length; }\n\
                 if (typeof state.note === \"object\" && state.note !== null) { state.note.title; }\n\
                 if (state.note !== undefined) { /*?*/(state.note); }\n\
               });\n"
            .to_string(),
    }]);
    let found: Vec<&str> = analysis.modules[0]
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.id)
        .collect();
    assert_eq!(
        found,
        ["schema:unknown-type-access", "schema:unknown-type-access"]
    );
}

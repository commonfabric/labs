//! Optional properties of an input (`language-subset.md` §7.6.1): a
//! top-level property of the input of a `pattern` whose type declares a
//! default is read without `undefined`, and every other optional property
//! is read with it.

use pattern_compiler::program::{analyze, types_at_markers, SourceFile};

const PRELUDE: &str = "import { Cell, computed, type Default, handler, lift, pattern, Stream, \
Writable, type ReadonlyCell } from \"commonfabric\";\n\
interface Entry { id: string }\n";

fn types(snippet: &str) -> Vec<String> {
    types_at_markers(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("{PRELUDE}{snippet}"),
    }])
}

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

const INPUT: &str = "interface Input {\n\
  chosen?: Writable<string | Default<\"\">>;\n\
  glaze?: Default<string, \"plain\">;\n\
  events?: Writable<Entry[] | Default<[]>>;\n\
  note?: Writable<string>;\n\
  plain?: string;\n\
  nested: { glaze?: Default<string, \"plain\"> };\n\
}\n";

#[test]
fn optional_property_with_a_default_is_read_without_undefined_from_the_destructuring() {
    assert_eq!(
        types(&format!(
            "{INPUT}const P = pattern<Input, {{ n: number }}>(({{ chosen, glaze, note, plain }}) => {{\n\
               const a = /*?*/chosen;\n\
               const b = /*?*/(chosen.get());\n\
               const c = /*?*/glaze;\n\
               const d = /*?*/note;\n\
               const e = /*?*/plain;\n\
               return {{ n: 1 }};\n\
             }});\n"
        )),
        [
            "Cell<string @default>",
            "string @default",
            "string @default",
            "Cell<string> | undefined",
            "string | undefined"
        ]
    );
}

#[test]
fn optional_property_with_a_default_is_read_without_undefined_from_the_parameter() {
    assert_eq!(
        types(&format!(
            "{INPUT}const P = pattern<Input, {{ n: number }}>((input) => {{\n\
               const a = /*?*/(input.events);\n\
               const b = /*?*/(input.glaze);\n\
               const c = /*?*/(input.plain);\n\
               return {{ n: 1 }};\n\
             }});\n\
             const Q = pattern((input: Input) => {{\n\
               const a = /*?*/(input.glaze);\n\
               return {{ n: 1 }};\n\
             }});\n"
        )),
        [
            "Cell<{ id: string }[] @default>",
            "string @default",
            "string | undefined",
            "string @default"
        ]
    );
}

#[test]
fn nested_property_with_a_default_keeps_undefined() {
    assert_eq!(
        types(&format!(
            "{INPUT}const P = pattern<Input, {{ n: number }}>(({{ nested }}) => {{\n\
               const a = /*?*/(nested.glaze);\n\
               return {{ n: 1 }};\n\
             }});\n"
        )),
        ["string @default | undefined"]
    );
}

#[test]
fn handler_state_and_event_and_lift_argument_keep_undefined() {
    assert_eq!(
        types(&format!(
            "{INPUT}const h = handler<Input, Input>((event, state) => {{\n\
               const a = /*?*/(event.glaze);\n\
               const b = /*?*/(state.chosen);\n\
             }});\n\
             const l = lift((input: Input) => /*?*/(input.glaze));\n"
        )),
        [
            "string @default | undefined",
            "Cell<string @default> | undefined",
            "string @default | undefined"
        ]
    );
}

const SAVE: &str = "const save = handler<unknown, { events: Writable<Entry[]> }>((_, state) => { state.events.push({ id: \"a\" }); });\n\
const note = handler<unknown, { note: Writable<string> }>((_, state) => { state.note.set(\"\"); });\n";

#[test]
fn optional_property_with_a_default_is_accepted_where_the_callee_requires_it() {
    let found = mismatches(&format!(
        "{INPUT}{SAVE}const P = pattern<Input, {{ save: Stream<unknown> }}>(({{ events }}) => ({{ save: save({{ events }}) }}));\n"
    ));
    assert!(found.is_empty(), "{found:?}");
}

#[test]
fn optional_property_without_a_default_is_refused_where_the_callee_requires_it() {
    let found = mismatches(&format!(
        "{INPUT}{SAVE}const P = pattern<Input, {{ save: Stream<unknown> }}>(({{ note: n }}) => ({{ save: note({{ note: n }}) }}));\n"
    ));
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].contains("optional property"), "{found:?}");
}

#[test]
fn property_with_a_default_and_no_question_mark_is_required_of_the_caller() {
    let found = mismatches(
        "const Row = pattern<{ glaze: Default<string, \"plain\">; name: string }, { n: number }>(({ name }) => ({ n: 1 }));\n\
         const P = pattern<{ name: string }, { n: number }>(({ name }) => Row({ name }));\n",
    );
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].contains("glaze"), "{found:?}");
}

//! A member of a cell handle that the API does not declare
//! (`language-subset.md` §4.7). The executor hands a function body an
//! object of its own for a handle, so a member the table of §4.7 does not
//! list is a member of that object and no part of the language.

use pattern_compiler::program::{analyze, SourceFile};

/// The identifier and the excerpt of each diagnostic that refuses a
/// handler body written as `body`, with the state `last: Writable<string>`
/// and `log: Writable<string[]>`.
fn refusals(body: &str) -> Vec<(String, String)> {
    let source = format!(
        r#"import {{ handler, pattern, type Stream, Writable }} from "commonfabric";
const record = handler<{{ text: string }}, {{ last: Writable<string>; log: Writable<string[]> }}>(
  (event, {{ last, log }}) => {{
    {body}
  }},
);
export default pattern<{{ note: string }}, {{ last: string; record: Stream<{{ text: string }}> }}>(({{ note }}) => {{
  const last = Writable.of("");
  const log = Writable.of<string[]>([]);
  return {{ last, record: record({{ last, log }}) }};
}});
"#
    );
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: source.clone(),
    }]);
    let module = &analysis.modules[0];
    if module.accepted() {
        return Vec::new();
    }
    module
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == pattern_compiler::diagnostics::Severity::Error)
        .map(|diagnostic| {
            let excerpt = &source[diagnostic.start as usize..diagnostic.end as usize];
            (diagnostic.id.to_string(), excerpt.to_string())
        })
        .collect()
}

fn unsupported(excerpt: &str) -> Vec<(String, String)> {
    vec![("cell:unsupported-method".to_string(), excerpt.to_string())]
}

#[test]
fn the_methods_of_a_handle_are_accepted() {
    assert_eq!(refusals("last.set(event.text); log.push(last.get());"), []);
    assert_eq!(refusals("log.key(0).set(event.text);"), []);
}

#[test]
fn a_read_of_an_undeclared_member_of_a_handle_is_refused() {
    assert_eq!(
        refusals("last.set(typeof last.instance);"),
        unsupported("last.instance")
    );
    assert_eq!(
        refusals("last.set(String(last.target.doc));"),
        unsupported("last.target")
    );
}

#[test]
fn a_call_of_an_undeclared_member_of_a_handle_is_refused() {
    assert_eq!(
        refusals("last.refusingWrites(last);"),
        unsupported("last.refusingWrites")
    );
}

#[test]
fn an_undeclared_member_of_a_handle_read_with_a_computed_key_is_refused() {
    assert_eq!(
        refusals(r#"last.set(typeof last["instance"]);"#),
        unsupported(r#"last["instance"]"#)
    );
    assert_eq!(
        refusals("last.set(typeof last[event.text]);"),
        unsupported("last[event.text]")
    );
}

#[test]
fn a_write_of_a_member_of_a_handle_is_refused() {
    assert_eq!(
        refusals("last.added = event.text;"),
        unsupported("last.added")
    );
    assert_eq!(refusals("last.set = () => last;"), unsupported("last.set"));
}

#[test]
fn the_object_members_of_a_handle_are_refused() {
    assert_eq!(
        refusals("last.set(String(last.constructor));"),
        unsupported("last.constructor")
    );
}

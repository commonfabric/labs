//! A name that begins with `$` is the compiler's: the emitted value code
//! binds `$rt`, `$h`, `$arg`, `$exports`, `$e`, `$s` and names it makes
//! itself around the authored code, so an authored binding of such a name
//! would be read as the emitted one where the two scopes meet.

use pattern_compiler::diagnostics::Severity;
use pattern_compiler::program::{analyze, SourceFile};

/// The identifier and the excerpt of each error of a module.
fn errors(source: &str) -> Vec<(String, String)> {
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: source.to_string(),
    }]);
    analysis.modules[0]
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == Severity::Error)
        .map(|diagnostic| {
            let excerpt = &source[diagnostic.start as usize..diagnostic.end as usize];
            (diagnostic.id.to_string(), excerpt.to_string())
        })
        .collect()
}

fn reserved(names: &[&str]) -> Vec<(String, String)> {
    names
        .iter()
        .map(|name| ("stdlib:unsupported-member".to_string(), name.to_string()))
        .collect()
}

#[test]
fn a_constant_of_module_scope_named_as_the_host_of_a_call_is_refused() {
    // Without the refusal the inline handler reads the host that the
    // emitted setup function binds as `$h`.
    let source = r#"import { pattern, UI, Writable } from "commonfabric";
const $h = ["plain"];
export default pattern<{ note: string }, { last: string }>(({ note }) => {
  const last = Writable.of("");
  return {
    last,
    [UI]: <button onClick={() => { last.set($h.at(0) ?? ""); }}>x</button>,
  };
});
"#;
    assert_eq!(errors(source), reserved(&["$h"]));
}

#[test]
fn a_parameter_a_local_and_a_function_named_with_a_dollar_sign_are_refused() {
    let source = r#"import { lift, pattern } from "commonfabric";
function $helper(text: string): string {
  return text;
}
const shown = lift(({ $arg }: { $arg: string }) => {
  const $local = $helper($arg);
  return $local;
});
export default pattern<{ note: string }>(({ note }) => {
  return { shown: shown({ $arg: note }) };
});
"#;
    assert_eq!(errors(source), reserved(&["$helper", "$arg", "$local"]));
}

#[test]
fn a_name_with_a_dollar_sign_after_its_first_character_is_accepted() {
    let source = r#"import { lift, pattern } from "commonfabric";
const price$ = lift(({ cost }: { cost: number }) => cost * 2);
export default pattern<{ cost: number }>(({ cost }) => {
  return { shown: price$({ cost }) };
});
"#;
    assert_eq!(errors(source), []);
}

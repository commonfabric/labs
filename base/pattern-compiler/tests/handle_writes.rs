//! A write through a handle bound to a computed value (ruling T3 of
//! 2026-11-14; `docs/plans/compiled-pattern-language.md`, "Decided").

use pattern_compiler::diagnostics::Severity;
use pattern_compiler::program::{analyze, ProgramAnalysis, SourceFile};

const PRELUDE: &str = r#"import { computed, handler, pattern, UI, Writable } from "commonfabric";
interface Link { url: string; removedAt?: number }
const retract = handler<unknown, { link: Writable<Link> }>((_, state) => {
  state.link.key("removedAt").set(1);
});
const rename = handler<unknown, { name: Writable<string> }>((_, state) => {
  state.name.set("x");
});
const peek = handler<unknown, { name: Writable<string>; seen: Writable<string[]> }>((_, state) => {
  state.seen.push(state.name.get());
});
"#;

fn program(text: &str) -> ProgramAnalysis {
    analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("{PRELUDE}{text}"),
    }])
}

/// The cases the plan of the first pattern lists, in source order.
fn cases(analysis: &ProgramAnalysis) -> Vec<String> {
    analysis.modules[0].plans[0]
        .handle_writes
        .iter()
        .map(|write| write.case.to_string())
        .collect()
}

/// The severity and the excerpt of each `binding:write-to-computed`.
fn reports(analysis: &ProgramAnalysis, text: &str) -> Vec<(Severity, String)> {
    let source = format!("{PRELUDE}{text}");
    analysis.modules[0]
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.id == "binding:write-to-computed")
        .map(|diagnostic| {
            let from = diagnostic.start as usize;
            let line = source[from..].lines().next().unwrap_or("");
            (diagnostic.severity, line.chars().take(20).collect())
        })
        .collect()
}

#[test]
fn a_write_through_an_element_a_filter_in_a_computed_passes_on_lands_in_the_stored_place() {
    // "an element that a `filter` ... in a `computed` yields ... The handle
    // resolves through the reference to that place and the write lands
    // there." The corpus example is `linksView` of `topic.tsx`.
    let text = r#"export const Topic = pattern<{ links: Writable<Link[]> }>(({ links }) => {
  const linksView = computed(() => links.get().filter((link) => link.removedAt === undefined));
  return { [UI]: <div>{linksView.map((link) => <button onClick={retract({ link })}>x</button>)}</div> };
});
"#;
    let analysis = program(text);
    assert_eq!(cases(&analysis), ["reference"]);
    assert_eq!(reports(&analysis, text), []);
    // The binding's entry says that the handle resolves through the
    // reference.
    let plan = &analysis.modules[0].plans[0].plan;
    assert_eq!(plan["bindings"][0]["state"][0]["through"], "reference");
}

#[test]
fn a_filter_in_a_computed_that_stays_a_body_passes_its_elements_on() {
    let text = r#"export const Topic = pattern<{ links: Writable<Link[]>; on: boolean }>(({ links, on }) => {
  const linksView = computed(() => {
    if (!on) { return []; }
    const all = links.get();
    return all.filter((link) => link.removedAt === undefined);
  });
  return { [UI]: <div>{linksView.map((link) => <button onClick={retract({ link })}>x</button>)}</div> };
});
"#;
    let analysis = program(text);
    assert_eq!(cases(&analysis), ["reference"]);
    assert_eq!(reports(&analysis, text), []);
}

#[test]
fn a_write_through_a_value_the_instance_produces_is_an_error_and_a_read_is_counted() {
    // "The value at the bound path is produced by the instance (a
    // `computed` result, an operator result, a literal): a write through
    // the handle is refused at run time, and the compiler reports it where
    // the handle is declared writable and the callee writes." LS §10.2 has
    // `binding:write-to-computed` as an error, and nothing for a callee
    // that only reads.
    let text = r#"export const P = pattern<{ name: string; seen: Writable<string[]> }>(({ name, seen }) => {
  const upper = computed(() => name.toUpperCase());
  return {
    bad: rename({ name: upper }),
    worse: rename({ name: name + "!" }),
    read: peek({ name: upper, seen }),
    fine: rename({ name }),
  };
});
"#;
    let analysis = program(text);
    assert_eq!(cases(&analysis), ["computed: written", "computed: written", "computed: read"]);
    assert_eq!(
        reports(&analysis, text),
        [
            (Severity::Error, "upper }),".to_string()),
            (Severity::Error, "name + \"!\" }),".to_string()),
        ]
    );
}

#[test]
fn a_selection_between_stored_places_is_a_reference_and_one_with_a_computed_branch_is_mixed() {
    let text = r#"export const P = pattern<{ a: string; b: string; on: boolean }>(({ a, b, on }) => {
  const either = on ? a : b;
  const some = on ? a : a + "!";
  return { one: rename({ name: either }), two: rename({ name: some }) };
});
"#;
    let analysis = program(text);
    assert_eq!(cases(&analysis), ["reference", "mixed: written"]);
    // LS §10.2: "Not reported where the path can hold a reference on some
    // evaluation ... the runtime decides those per write."
    assert_eq!(reports(&analysis, text), []);
}

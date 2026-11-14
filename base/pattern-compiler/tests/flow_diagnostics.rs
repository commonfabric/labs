//! The label-flow diagnostics the compiler decides
//! (`plan-and-label-templates.md` §4.4, "What the compiler decides",
//! cited as PL): for each, a case that is reported, one that fits, and
//! one the compiler leaves to the runtime.

use pattern_compiler::program::{analyze, ProgramAnalysis, SourceFile};
use serde_json::{json, Value};

const PRELUDE: &str = r#"import { Cell, UI, UiAction, Writable, computed, handler, lift, pattern, type Confidential, type CurrentPrincipal, type Integrity, type MaxConfidentiality, type RequiresIntegrity, type TrustedActionWrite } from "commonfabric";
type Pub<T> = Confidential<T, readonly ["public"]>;
type Sec<T> = Confidential<T, readonly ["secret"]>;
type Mine<T> = Confidential<T, readonly [{ kind: "user"; subject: CurrentPrincipal }]>;
type Reviewed<T> = Integrity<T, readonly ["reviewed"]>;
type Draft<T> = Integrity<T, readonly ["draft"]>;
type Concept = { type: "https://commonfabric.org/cfc/atom/Concept"; uri: "urn:reviewed" };
"#;

fn analysis(snippet: &str) -> ProgramAnalysis {
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("{PRELUDE}{snippet}"),
    }]);
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    analysis
}

/// The `cfc-flow:*` reports of a module, and every other error.
fn flows(snippet: &str) -> Vec<&'static str> {
    let analysis = analysis(snippet);
    let diagnostics: Vec<_> = analysis.modules.iter().flat_map(|module| &module.diagnostics).collect();
    let other: Vec<_> = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.is_error() && !diagnostic.id.starts_with("cfc-flow:"))
        .map(|diagnostic| (diagnostic.id, diagnostic.line, &diagnostic.message))
        .collect();
    assert!(other.is_empty(), "{other:?}");
    diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.id.starts_with("cfc-flow:"))
        .map(|diagnostic| diagnostic.id)
        .collect()
}

fn gate(state: &str) -> String {
    format!(
        "const gate = handler<{{ t: string }}, {{ {state}; n: Cell<number> }}>((event, state) => {{
  if (state.v) state.n.set(1);
}});
export const P = pattern<{{ {state}; n: Cell<number> }}>(({{ v, n }}) => ({{ gate: gate({{ v, n }}) }}));
"
    )
}

// ----- cfc-flow:max-confidentiality -----

#[test]
fn max_confidentiality_is_reported_for_a_declared_clause_the_ceiling_does_not_admit() {
    // "A clause of the declared confidentiality of a listed slot ... is
    // subsumed by no clause of `ceiling`."
    assert_eq!(
        flows(&gate("v: MaxConfidentiality<Sec<string>, readonly [\"public\"]>")),
        ["cfc-flow:max-confidentiality"]
    );
}

#[test]
fn max_confidentiality_is_silent_where_the_declared_clauses_fit() {
    // "A check that does not fail this way is not decided: it is never a
    // pass."
    assert!(flows(&gate("v: MaxConfidentiality<Sec<string>, readonly [\"secret\", \"public\"]>")).is_empty());
}

#[test]
fn max_confidentiality_is_silent_on_a_run_time_term_a_policy_atom_and_an_undeclared_input() {
    // "An input has no declared confidentiality; ... a run-time term is
    // involved; ... any clause of the inputs or of the ceiling holds a
    // `Policy` atom."
    assert!(flows(&gate("v: MaxConfidentiality<Mine<string>, readonly [\"public\"]>")).is_empty());
    assert!(flows(&gate(
        "v: MaxConfidentiality<Sec<string>, readonly [{ kind: \"user\"; subject: CurrentPrincipal }]>"
    ))
    .is_empty());
    assert!(flows(&gate(
        "v: MaxConfidentiality<Sec<string>, readonly [{ type: \"https://commonfabric.org/cfc/atom/Policy\"; name: \"p\" }]>"
    ))
    .is_empty());
    assert!(flows(&gate("v: MaxConfidentiality<string, readonly [\"public\"]>")).is_empty());
}

#[test]
fn max_confidentiality_of_a_formal_input_of_a_lift_guards_the_output_it_derives() {
    // PL §1.5: "each `requiredIntegrity` and `maxConfidentiality`
    // annotation of the types of the body's formal inputs", listed "in
    // the `constraints` ... of every output whose template has a
    // `derive` by that body".
    let source = "const upper = lift((x: MaxConfidentiality<string, readonly [\"public\"]>) => x.toUpperCase());
export const P = pattern<{ secret: Sec<string> }>(({ secret }) => ({ up: upper(secret) }));
";
    assert_eq!(flows(source), ["cfc-flow:max-confidentiality"]);
    let analysis = analysis(source);
    let plan = &analysis.modules[0].plans[0].plan;
    let up = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| output["path"] == json!(["up"]))
        .expect("the output");
    let listed: Vec<&Value> = up["constraints"]
        .as_array()
        .expect("constraints")
        .iter()
        .map(|index| &plan["constraints"][index.as_u64().expect("an index") as usize])
        .collect();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["kind"], "maxConfidentiality");
    assert_eq!(listed[0]["ceiling"], json!(["public"]));
    let slot = &plan["slots"][listed[0]["slots"][0].as_u64().expect("a slot") as usize];
    assert_eq!(slot["path"], json!(["secret"]));
}

#[test]
fn an_input_constraint_lists_a_slot_above_the_annotated_path() {
    // "Lists the inputs of the body's footprint whose path overlaps the
    // annotated path, in either prefix direction."
    let source = "interface Doc { text: MaxConfidentiality<string, readonly [\"public\"]> }
const show = lift((doc: Doc) => JSON.stringify(doc));
export const P = pattern<{ doc: Sec<Doc> }>(({ doc }) => ({ shown: show(doc) }));
";
    let analysis = analysis(source);
    let plan = &analysis.modules[0].plans[0].plan;
    let constraint = plan["constraints"]
        .as_array()
        .expect("constraints")
        .iter()
        .find(|constraint| constraint["kind"] == "maxConfidentiality")
        .expect("the constraint");
    let slot = &plan["slots"][constraint["slots"][0].as_u64().expect("a slot") as usize];
    assert_eq!(slot["path"], json!(["doc"]));
    assert_eq!(flows(source), ["cfc-flow:max-confidentiality"]);
}

// ----- cfc-flow:required-integrity -----

#[test]
fn required_integrity_is_reported_where_no_declared_atom_satisfies_a_pattern() {
    // "Every listed input has a declared integrity ... and for some
    // pattern no one atom satisfies it in all of them."
    assert_eq!(
        flows(&gate("v: RequiresIntegrity<Draft<string>, readonly [\"reviewed\"]>")),
        ["cfc-flow:required-integrity"]
    );
}

#[test]
fn required_integrity_passes_where_a_declared_atom_satisfies_each_pattern() {
    assert!(flows(&gate("v: RequiresIntegrity<Reviewed<string>, readonly [\"reviewed\"]>")).is_empty());
}

#[test]
fn required_integrity_is_silent_on_a_concept_pattern_and_an_undeclared_input() {
    // "An input has no declared integrity; ... a pattern is a `Concept`
    // pattern or holds another run-time term."
    assert!(flows(&gate("v: RequiresIntegrity<Draft<string>, readonly [Concept]>")).is_empty());
    assert!(flows(&gate("v: RequiresIntegrity<string, readonly [\"reviewed\"]>")).is_empty());
}

// ----- cfc-flow:write-floor -----

fn floored(inputs: &str, floor: &str, value: &str) -> String {
    format!(
        "export const P = pattern<{{ {inputs} }}, {{ out: RequiresIntegrity<string, readonly [{floor}]> }}>(({{ a, b }}) => ({{ out: {value} }}));
"
    )
}

#[test]
fn write_floor_is_reported_where_the_integrity_of_the_template_lacks_a_pattern() {
    // "`I(template)` evaluates and does not satisfy `patterns`": the
    // atoms every input of the `derive` has.
    assert_eq!(
        flows(&floored("a: Reviewed<string>; b: Draft<string>", "\"reviewed\"", "a + b")),
        ["cfc-flow:write-floor"]
    );
}

#[test]
fn write_floor_passes_where_every_input_declares_the_atom() {
    assert!(flows(&floored("a: Reviewed<string>; b: Reviewed<string>", "\"reviewed\"", "a + b")).is_empty());
}

#[test]
fn write_floor_is_silent_on_a_concept_pattern_an_undeclared_input_and_a_pattern_the_minted_atom_can_match() {
    // "The template does not evaluate; ... a run-time term is involved",
    // and "where a pattern can match a `TransformedBy` atom and the
    // compiler has no `Body.code` or `Cone.code` to form the atom from,
    // the check is not decided."
    assert!(flows(&floored("a: Reviewed<string>; b: Draft<string>", "Concept", "a + b")).is_empty());
    assert!(flows(&floored("a: Reviewed<string>; b: string", "\"reviewed\"", "a + b")).is_empty());
    assert!(flows(&floored(
        "a: Reviewed<string>; b: Draft<string>",
        "{ type: \"https://commonfabric.org/cfc/atom/TransformedBy\" }",
        "a + b"
    ))
    .is_empty());
}

// ----- cfc-flow:writer-fit -----

fn kept(input: &str, output: &str) -> String {
    format!(
        "export const P = pattern<{{ v: {input} }}, {{ out: {output} }}>(({{ v }}) => ({{ out: v + \"!\" }}));
"
    )
}

#[test]
fn writer_fit_is_reported_for_a_clause_the_target_does_not_declare() {
    // "A clause of the lower bound of `C(template)` is subsumed by no
    // clause declared at the target, and no alternative of that clause
    // is an atom of type `Space`, `PersonalSpace` or `User`."
    assert_eq!(flows(&kept("Sec<string>", "Pub<string>")), ["cfc-flow:writer-fit"]);
}

#[test]
fn writer_fit_is_silent_where_the_declared_clauses_fit() {
    assert!(flows(&kept("Sec<string>", "Sec<string>")).is_empty());
    assert!(flows(&kept("string", "Pub<string>")).is_empty());
}

#[test]
fn writer_fit_is_silent_on_a_run_time_term_and_a_clause_residency_could_admit() {
    // "The failing clause has such an alternative; a `Policy` atom or
    // another run-time term is involved."
    assert!(flows(&kept("Mine<string>", "Pub<string>")).is_empty());
    assert!(flows(&kept(
        "Confidential<string, readonly [{ type: \"https://commonfabric.org/cfc/atom/User\"; subject: \"did:key:a\" }]>",
        "Pub<string>"
    ))
    .is_empty());
}

#[test]
fn a_write_through_a_handle_reads_the_identity_slot_and_is_not_decided() {
    // PL §1.5, question 55: "an `identity` slot and a `shape` slot in
    // place have no `declared` member", so "a compile-time check then
    // never fails on such a slot and is left to instantiation". The
    // record is in the plan all the same, on a `state` target too.
    let source = "export const P = pattern<{ secret: Sec<string> }>(({ secret }) => {
  const st = Writable.of<Pub<string>>(\"\");
  const fill = computed(() => { st.set(secret); return 1; });
  return { fill, st };
});
";
    assert!(flows(source).is_empty());
    let analysis = analysis(source);
    let plan = &analysis.modules[0].plans[0].plan;
    let write = &plan["bodies"][0]["writes"][0];
    assert_eq!(write["target"]["kind"], "state");
    let listed: Vec<&Value> = write["constraints"]
        .as_array()
        .expect("constraints")
        .iter()
        .map(|index| &plan["constraints"][index.as_u64().expect("an index") as usize])
        .collect();
    assert_eq!(listed, [&json!({ "kind": "writerFit" })]);
    for slot in plan["slots"].as_array().expect("slots") {
        if slot["observes"] == "identity" {
            assert!(slot.get("declared").is_none(), "{slot}");
        }
    }
}

// ----- cfc-flow:ui-contract -----

fn surface(element: &str) -> String {
    format!(
        "const SEND = \"send\";
const SURFACE = \"compose\";
interface Note {{ text: TrustedActionWrite<string, typeof send, typeof SEND, typeof SURFACE> }}
const send = handler<{{ text: string }}, {{ note: Cell<Note> }}>((event, state) => {{
  state.note.key(\"text\").set(event.text);
}});
export const P = pattern<{{ note: Cell<Note>; name: string }}>(({{ note, name }}) => ({{
  [UI]: (<div>{element}</div>),
}}));
"
    )
}

fn warnings(snippet: &str) -> Vec<&'static str> {
    let analysis = analysis(snippet);
    analysis
        .modules
        .iter()
        .flat_map(|module| &module.diagnostics)
        .filter(|diagnostic| diagnostic.id == "cfc-flow:ui-contract")
        .map(|diagnostic| {
            assert!(!diagnostic.is_error());
            diagnostic.id
        })
        .collect()
}

#[test]
fn ui_contract_is_reported_where_no_binding_element_sits_under_the_surface() {
    // "The plan has at least one element that binds the handler, none
    // of them satisfies the contract, and the surface of each is
    // decided."
    assert_eq!(
        warnings(&surface("<button onClick={send({ note })}>Send</button>")),
        ["cfc-flow:ui-contract"]
    );
    // The action is another one.
    assert_eq!(
        warnings(&surface(
            "<section data-ui-pattern=\"compose\" data-ui-event-integrity=\"compose\"><UiAction action=\"discard\" onClick={send({ note })}>Send</UiAction></section>"
        )),
        ["cfc-flow:ui-contract"]
    );
}

#[test]
fn ui_contract_is_silent_where_an_element_satisfies_the_contract() {
    // "The contract's `trustedPattern` ... is the surface's pattern,
    // every name of `requiredEventIntegrity` is among the surface's
    // integrity names, and, for the helper `UiAction`, the contract's
    // `action` is the value of `data-ui-action`."
    assert!(warnings(&surface(
        "<section data-ui-pattern=\"compose\" data-ui-event-integrity=\"other, compose\"><UiAction action=\"send\" onClick={send({ note })}>Send</UiAction></section>"
    ))
    .is_empty());
}

#[test]
fn ui_contract_is_silent_where_a_surface_is_not_decided_or_nothing_binds_the_handler() {
    // "A surface is decided where every one of those attributes on its
    // chain is a constant ... and no element of the chain has a spread
    // attribute. Where a surface is not decided, and where no element of
    // the plan binds the handler, the compiler is silent."
    assert!(warnings(&surface(
        "<section data-ui-pattern={name}><button onClick={send({ note })}>Send</button></section>"
    ))
    .is_empty());
    assert!(warnings(&surface("<span>{name}</span>")).is_empty());
}

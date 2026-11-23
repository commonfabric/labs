//! The identity of a handler a write policy names, and the form of a writer
//! policy in a schema: `Body.code` of a handler declared at a `const` of
//! module scope (`plan-and-label-templates.md` §1.5, cited as PL), and the
//! writer claim of `docs/specs/schema-generator/ts_to_json_schema_mapping.md`
//! §11 (cited as SM), which the runtime's commit preparation reads.

use pattern_compiler::program::{analyze, ProgramAnalysis, SourceFile};
use serde_json::{json, Value};

const SOURCE: &str = r#"import { handler, pattern, Stream, Writable, type TrustedActionWrite, type WriteAuthorizedBy, type WritePolicyAnyOf } from "commonfabric";
const SEND = "send";
const SURFACE = "surface";
const send = handler<{ text: string }, { note: Writable<string> }>((event, { note }) => { note.set(event.text); });
const edit = handler<{ text: string }, { note: Writable<string> }>((event, { note }) => { note.set(event.text); });
type Lone = WriteAuthorizedBy<string, typeof send>;
type Trusted = TrustedActionWrite<string, typeof send, typeof SEND, typeof SURFACE>;
type Either = WritePolicyAnyOf<string, [
  TrustedActionWrite<unknown, typeof send, typeof SEND, typeof SURFACE>,
  WriteAuthorizedBy<unknown, typeof edit>,
]>;
export default pattern<Record<string, never>, { lone: Lone; trusted: Trusted; either: Either; send: Stream<{ text: string }>; edit: Stream<{ text: string }> }>(() => {
  const lone = new Writable<Lone>("");
  const trusted = new Writable<Trusted>("");
  const either = new Writable<Either>("");
  return { lone, trusted, either, send: send({ note: lone }), edit: edit({ note: either }) };
});
"#;

fn analysis(text: &str) -> ProgramAnalysis {
    analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: text.to_string(),
    }])
}

/// `ifc` of the property `name` of the result schema of the first plan.
fn result_ifc(analysis: &ProgramAnalysis, name: &str) -> Value {
    let emitted = &analysis.modules[0].plans[0];
    let id = emitted.plan["resultSchema"].as_str().expect("resultSchema");
    let (_, document) = emitted
        .schemas
        .iter()
        .find(|(other, _)| other == id)
        .expect("the result schema");
    document["properties"][name]["ifc"].clone()
}

/// `Body.code` of the body `name` of the first plan.
fn code_of(analysis: &ProgramAnalysis, name: &str) -> Value {
    analysis.modules[0].plans[0].plan["bodies"]
        .as_array()
        .expect("bodies")
        .iter()
        .find(|body| body["name"] == json!(name))
        .unwrap_or_else(|| panic!("no body {name}"))["code"]
        .clone()
}

#[test]
fn a_handler_at_a_module_scope_binding_has_the_identity_of_its_module_and_its_binding() {
    // PL §1.5: "`Body.code` identifies a sandboxed body by the module that
    // declares it and the binding it is declared at."
    let analysis = analysis(SOURCE);
    let send = code_of(&analysis, "send");
    let edit = code_of(&analysis, "edit");
    assert_eq!(send["binding"], json!(["send"]));
    assert_eq!(edit["binding"], json!(["edit"]));
    let module = send["module"].as_str().expect("the identity of the module");
    assert!(module.starts_with("sha256:"), "{module}");
    assert_eq!(edit["module"], json!(module));
    // The identity is of the text of the module: another text at the same
    // path has another identity.
    let other = analysis_of_changed_text();
    assert_ne!(code_of(&other, "send")["module"], json!(module));
}

fn analysis_of_changed_text() -> ProgramAnalysis {
    analysis(&SOURCE.replace("note.set(event.text);", "note.set(event.text + \"!\");"))
}

#[test]
fn a_writer_policy_is_a_writer_claim_in_a_schema() {
    // SM §11: "`WriteAuthorizedBy<T, typeof b>` | `{ writeAuthorizedBy: {
    // __ctWriterIdentityOf: { file, path: [binding] } } }`", with the
    // identity of the module, which is what the claim is checked by.
    let analysis = analysis(SOURCE);
    let module = code_of(&analysis, "send")["module"].clone();
    let claim = |binding: &str| json!({ "__ctWriterIdentityOf": { "file": "case.tsx", "path": [binding], "moduleIdentity": module } });
    let contract = json!({
        "helper": "UiAction",
        "action": "send",
        "trustedPattern": "surface",
        "requiredEventIntegrity": ["surface"],
    });
    assert_eq!(
        result_ifc(&analysis, "lone"),
        json!({ "writeAuthorizedBy": claim("send") })
    );
    // The UI contract of a trusted action is beside the claim.
    assert_eq!(
        result_ifc(&analysis, "trusted"),
        json!({ "writeAuthorizedBy": claim("send"), "uiContract": contract })
    );
    // Each alternative holds its claim and its contract.
    assert_eq!(
        result_ifc(&analysis, "either"),
        json!({ "writePolicyAnyOf": [
            { "writeAuthorizedBy": claim("send"), "uiContract": contract },
            { "writeAuthorizedBy": claim("edit") },
        ] })
    );
}

#[test]
fn a_ui_contract_that_names_no_integrity_requires_that_of_its_pattern() {
    // SM §11: `TrustedActionUiContract<T, Action, Pattern>` declares the
    // contract `TrustedActionWrite` declares for the same action and
    // pattern, so a handler whose state type restates the contract of a
    // position declares the contract the position has.
    let source = SOURCE
        .replace("type TrustedActionWrite,", "type TrustedActionUiContract, type TrustedActionWrite,")
        .replace(
            "type Lone = ",
            "type Restated = TrustedActionUiContract<string, typeof SEND, typeof SURFACE>;\ntype Lone = ",
        )
        .replace("lone: Lone; trusted", "restated: Restated; lone: Lone; trusted")
        .replace(
            "const lone = new Writable<Lone>(\"\");",
            "const restated = new Writable<Restated>(\"\");\n  const lone = new Writable<Lone>(\"\");",
        )
        .replace("return { lone,", "return { restated, lone,");
    let analysis = analysis(&source);
    assert_eq!(
        result_ifc(&analysis, "restated")["uiContract"],
        result_ifc(&analysis, "trusted")["uiContract"]
    );
}

#[test]
fn a_handler_no_writer_policy_names_has_no_identity() {
    // Today's transformer gives a binding the identity a writer claim is
    // checked by only where some claim of the program names the binding
    // (`ModuleScopeFunctionHardeningTransformer`). A handler no policy
    // names is then a writer no claim admits, on both paths alike.
    let source = SOURCE
        .replace(
            "type Lone = ",
            "const plain = handler<{ text: string }, { note: Writable<string> }>((event, { note }) => { note.set(event.text); });\ntype Lone = ",
        )
        .replace(
            "edit: Stream<{ text: string }> }>",
            "edit: Stream<{ text: string }>; plain: Stream<{ text: string }> }>",
        )
        .replace(
            "edit: edit({ note: either }) }",
            "edit: edit({ note: either }), plain: plain({ note: lone }) }",
        );
    let analysis = analysis(&source);
    assert_eq!(code_of(&analysis, "plain"), Value::Null);
    assert_eq!(code_of(&analysis, "send")["binding"], json!(["send"]));
    assert_eq!(code_of(&analysis, "edit")["binding"], json!(["edit"]));
}
